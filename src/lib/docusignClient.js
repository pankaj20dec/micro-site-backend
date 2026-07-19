import jwt from "jsonwebtoken";

const DEMO_AUTH_BASE = "https://account-d.docusign.com";
const PROD_AUTH_BASE = "https://account.docusign.com";
const DEMO_AUTH_HOST = "account-d.docusign.com";
const PROD_AUTH_HOST = "account.docusign.com";
const DEMO_API_BASE = "https://demo.docusign.net/restapi";

let cachedToken = null;
let tokenExpiresAt = 0;

function isPlaceholder(value) {
  return !value || value === "placeholder" || value === "...";
}

function normalizePrivateKey(value) {
  if (!value) return null;
  return value.replace(/\\n/g, "\n");
}

function getConfig() {
  const env = process.env.DOCUSIGN_ENV || "demo";
  const authBase = env === "production" ? PROD_AUTH_BASE : DEMO_AUTH_BASE;
  const apiBase =
    process.env.DOCUSIGN_API_BASE ||
    (env === "production" ? "https://na1.docusign.net/restapi" : DEMO_API_BASE);

  const authHost = env === "production" ? PROD_AUTH_HOST : DEMO_AUTH_HOST;

  return {
    env,
    authBase,
    authHost,
    apiBase,
    accountId: process.env.DOCUSIGN_ACCOUNT_ID,
    integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,
    userId: process.env.DOCUSIGN_USER_ID,
    privateKey: normalizePrivateKey(process.env.DOCUSIGN_PRIVATE_KEY),
    templateId: process.env.DOCUSIGN_TEMPLATE_ID,
    roleName: process.env.DOCUSIGN_TEMPLATE_ROLE_NAME || "Signer",
  };
}

export function isDocusignConfigured() {
  const config = getConfig();
  return (
    !isPlaceholder(config.accountId) &&
    !isPlaceholder(config.integrationKey) &&
    !isPlaceholder(config.userId) &&
    !isPlaceholder(config.privateKey) &&
    !isPlaceholder(config.templateId)
  );
}

export function getDocusignConsentUrl(redirectUri) {
  const { integrationKey, authBase } = getConfig();
  const params = new URLSearchParams({
    response_type: "code",
    scope: "signature impersonation",
    client_id: integrationKey,
    redirect_uri: redirectUri,
  });
  return `${authBase}/oauth/auth?${params.toString()}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { authBase, authHost, integrationKey, userId, privateKey } = getConfig();
  const assertion = jwt.sign(
    {
      iss: integrationKey,
      sub: userId,
      aud: authHost,
      scope: "signature impersonation",
    },
    privateKey,
    { algorithm: "RS256", expiresIn: "10m" }
  );

  const res = await fetch(`${authBase}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error_description || data.error || "DocuSign auth failed");
    err.code = data.error;
    err.status = res.status;
    throw err;
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function docusignRequest(path, options = {}) {
  const token = await getAccessToken();
  const { apiBase, accountId } = getConfig();
  const url = `${apiBase}/v2.1/accounts/${accountId}${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const err = new Error(data.message || data.errorCode || data.error || `DocuSign API ${res.status}`);
    err.status = res.status;
    err.code = data.errorCode || data.error;
    err.body = data;
    throw err;
  }

  return data;
}

export async function getTemplateDetails() {
  const { templateId } = getConfig();
  return docusignRequest(`/templates/${templateId}?include=recipients,tabs`);
}

function listSignerRoles(template) {
  return (template.recipients?.signers || []).map((signer) => signer.roleName);
}

function resolveTemplateSigner(template, preferredRoleName) {
  const signers = template.recipients?.signers || [];

  if (signers.length === 0) {
    const err = new Error(
      "DocuSign template has no signer roles. Add a signer with signature tabs in the DocuSign template editor."
    );
    err.code = "TEMPLATE_NO_SIGNERS";
    throw err;
  }

  const matched = signers.find((signer) => signer.roleName === preferredRoleName);
  if (matched) return matched;

  if (signers.length === 1) {
    return signers[0];
  }

  const err = new Error(
    `DOCUSIGN_TEMPLATE_ROLE_NAME "${preferredRoleName}" not found. Available roles: ${listSignerRoles(template).join(", ")}`
  );
  err.code = "TEMPLATE_ROLE_MISMATCH";
  err.availableRoles = listSignerRoles(template);
  throw err;
}

function buildTemplateRole(signerTemplate, { email, name, clientUserId }) {
  const role = {
    email,
    name,
    roleName: signerTemplate.roleName,
    clientUserId,
  };

  const textTabs = [];
  for (const tab of signerTemplate.tabs?.textTabs || []) {
    if (tab.required === "true" || tab.required === true) {
      textTabs.push({
        tabLabel: tab.tabLabel,
        value: tab.value || tab.originalValue || " ",
      });
    }
  }

  if (textTabs.length > 0) {
    role.tabs = { textTabs };
  }

  return role;
}

async function getEnvelopeSigners(envelopeId) {
  const envelope = await docusignRequest(`/envelopes/${envelopeId}?include=recipients`);
  return envelope.recipients?.signers || [];
}

async function normalizeEnvelopeSigner(envelopeId, { email, name, clientUserId }) {
  const signers = await getEnvelopeSigners(envelopeId);
  if (signers.length === 0) {
    const err = new Error("DocuSign envelope has no signers after creation.");
    err.code = "ENVELOPE_NO_SIGNERS";
    throw err;
  }

  const targetEmail = email.toLowerCase();
  const primary =
    signers.find((signer) => (signer.tabs?.signHereTabs || []).length > 0) ||
    signers.find((signer) => signer.routingOrder === "1") ||
    signers[0];

  const needsPrimaryUpdate =
    primary.email?.toLowerCase() !== targetEmail ||
    primary.name !== name ||
    (clientUserId && primary.clientUserId !== clientUserId);

  if (needsPrimaryUpdate) {
    await docusignRequest(`/envelopes/${envelopeId}/recipients`, {
      method: "PUT",
      body: JSON.stringify({
        signers: [
          {
            recipientId: primary.recipientId,
            email,
            name,
            clientUserId,
            roleName: primary.roleName || "signer",
          },
        ],
      }),
    });
  }

  for (const signer of signers) {
    if (signer.recipientId === primary.recipientId) continue;
    await docusignRequest(`/envelopes/${envelopeId}/recipients/${signer.recipientId}`, {
      method: "DELETE",
    });
  }
}

export async function createEnvelopeFromTemplate({
  signerEmail,
  signerName,
  clientUserId,
  documents = [],
}) {
  const { templateId, roleName } = getConfig();
  const template = await getTemplateDetails();
  const signers = template.recipients?.signers || [];

  if (signers.length > 1) {
    const err = new Error(
      `Template "${template.name || templateId}" requires ${signers.length} signers (${listSignerRoles(template).join(", ")}). Use a single-signer template for now.`
    );
    err.code = "TEMPLATE_MULTI_SIGNER";
    err.availableRoles = listSignerRoles(template);
    throw err;
  }

  const signerTemplate = resolveTemplateSigner(template, roleName);
  if (signerTemplate.email && signerTemplate.email.includes("@")) {
    console.warn(
      `DocuSign template role "${signerTemplate.roleName}" has a fixed recipient email (${signerTemplate.email}). Clear name/email on the template role so each user becomes the sole signer.`
    );
  }

  const signHereTabs = signerTemplate.tabs?.signHereTabs || [];
  if (signHereTabs.length === 0) {
    const err = new Error(
      `DocuSign template "${template.name || templateId}" has no Sign Here tabs for role "${signerTemplate.roleName}". Add at least one signature tab in the DocuSign template editor.`
    );
    err.code = "TEMPLATE_NO_SIGNATURE_TABS";
    throw err;
  }

  const templateRole = buildTemplateRole(signerTemplate, {
    email: signerEmail,
    name: signerName,
    clientUserId,
  });

  const envelope = await docusignRequest("/envelopes", {
    method: "POST",
    body: JSON.stringify({
      emailSubject: template.emailSubject || "Please sign your FIPO legal documents",
      templateId,
      templateRoles: [templateRole],
      status: "created",
    }),
  });

  await normalizeEnvelopeSigner(envelope.envelopeId, {
    email: signerEmail,
    name: signerName,
    clientUserId,
  });

  if (documents.length > 0) {
    await docusignRequest(`/envelopes/${envelope.envelopeId}/documents`, {
      method: "PUT",
      body: JSON.stringify({
        documents: documents.map((doc, index) => ({
          documentId: String(index + 2),
          name: doc.name.slice(0, 100),
          fileExtension: doc.extension,
          documentBase64: doc.base64,
        })),
      }),
    });
  }

  await docusignRequest(`/envelopes/${envelope.envelopeId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "sent" }),
  });

  return envelope.envelopeId;
}

export async function createRecipientView({
  envelopeId,
  signerEmail,
  signerName,
  clientUserId,
  returnUrl,
}) {
  const view = await docusignRequest(`/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    body: JSON.stringify({
      returnUrl,
      authenticationMethod: "none",
      email: signerEmail,
      userName: signerName,
      clientUserId,
    }),
  });

  return view.url;
}

export async function getEnvelopeStatus(envelopeId) {
  if (!envelopeId || String(envelopeId).startsWith("stub_")) {
    return {
      status: null,
      completedDateTime: null,
      signers: [],
      multipleSigners: false,
      pendingSigners: [],
    };
  }

  const envelope = await docusignRequest(`/envelopes/${envelopeId}?include=recipients`);
  const raw = String(envelope.status || "").toUpperCase();
  const statusMap = {
    SENT: "SENT",
    DELIVERED: "DELIVERED",
    COMPLETED: "COMPLETED",
    DECLINED: "DECLINED",
  };

  const isSignerDone = (status) => {
    const normalised = String(status || "").toLowerCase();
    return (
      normalised === "completed" ||
      normalised === "signed" ||
      normalised === "autoresponded"
    );
  };

  const signers = (envelope.recipients?.signers || []).map((signer) => ({
    name: signer.name,
    email: signer.email,
    status: String(signer.status || ""),
  }));

  const pendingSigners = signers.filter((signer) => !isSignerDone(signer.status));
  const multipleSigners = signers.length > 1;

  const allSignersCompleted =
    signers.length > 0 && signers.every((signer) => isSignerDone(signer.status));

  const mapped = statusMap[raw] || raw;
  const status = allSignersCompleted || mapped === "COMPLETED" ? "COMPLETED" : mapped;

  return {
    status,
    completedDateTime: envelope.completedDateTime || null,
    signers,
    multipleSigners,
    pendingSigners,
  };
}

export async function getEnvelopeCombinedPdf(envelopeId) {
  if (!envelopeId || String(envelopeId).startsWith("stub_")) {
    return null;
  }

  const token = await getAccessToken();
  const { apiBase, accountId } = getConfig();
  const url = `${apiBase}/v2.1/accounts/${accountId}/envelopes/${envelopeId}/documents/combined`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/pdf",
    },
  });

  if (!res.ok) {
    const err = new Error(`DocuSign document download failed (${res.status})`);
    err.status = res.status;
    throw err;
  }

  return Buffer.from(await res.arrayBuffer());
}
