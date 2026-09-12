import jwt from "jsonwebtoken";
import {
  canRegisterDocusignEnvelopeWebhook,
  isDocusignWebhookConfigured,
  isDocusignWebhookSecretConfigured,
  resolveDocusignWebhookUrl,
} from "./appBaseUrl.js";

const DEMO_AUTH_BASE = "https://account-d.docusign.com";
const PROD_AUTH_BASE = "https://account.docusign.com";
const DEMO_AUTH_HOST = "account-d.docusign.com";
const PROD_AUTH_HOST = "account.docusign.com";
const DEMO_API_BASE = "https://demo.docusign.net/restapi";

let cachedToken = null;
let tokenExpiresAt = 0;

/** @type {Map<string, { data: object; expiresAt: number }>} */
const envelopeStatusCache = new Map();
const ENVELOPE_STATUS_CACHE_MS = 60_000;
const ENVELOPE_STATUS_CACHE_COMPLETED_MS = 5 * 60_000;

export function clearEnvelopeStatusCache(envelopeId) {
  if (envelopeId) envelopeStatusCache.delete(String(envelopeId));
}

function isRateLimitError(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    err?.status === 429 ||
    message.includes("hourly limit") ||
    message.includes("rate limit") ||
    message.includes("polling calls")
  );
}

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
    witnessRoleName: process.env.DOCUSIGN_WITNESS_ROLE_NAME || "Witness",
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

function buildEnvelopeEventNotification() {
  if (!canRegisterDocusignEnvelopeWebhook()) return null;

  const url = resolveDocusignWebhookUrl();
  if (!url) return null;

  return {
    url,
    loggingEnabled: "true",
    requireAcknowledgment: "true",
    includeHMAC: "true",
    deliveryMode: "SIM",
    eventData: {
      version: "restv2.1",
      format: "json",
    },
    events: [
      "envelope-sent",
      "envelope-delivered",
      "envelope-completed",
      "envelope-declined",
    ],
  };
}

export {
  canRegisterDocusignEnvelopeWebhook,
  isDocusignWebhookConfigured,
  resolveDocusignWebhookUrl,
};

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
    const message = data.message || data.errorCode || data.error || `DocuSign API ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.code = data.errorCode || data.error;
    err.body = data;
    err.rateLimited = isRateLimitError(err);
    const code = String(err.code || "").toUpperCase();
    if (
      /invalid envelope status/i.test(String(message)) ||
      code === "INVALID_ENVELOPE_STATUS" ||
      code === "ENVELOPE_INVALID_STATUS"
    ) {
      err.code = "ENVELOPE_ALREADY_COMPLETED";
      err.message =
        "This document was already fully signed without a witness slot. Click Sign again in Stage 1 to start a fresh envelope with witness signing.";
    }
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

function resolveWitnessTemplateSigner(template, primaryRoleName, preferredWitnessRoleName) {
  const signers = template.recipients?.signers || [];
  if (signers.length <= 1) return null;

  const isDifferentFromPrimary = (signer) =>
    signer.roleName?.toLowerCase() !== String(primaryRoleName).toLowerCase();

  const matchers = [
    (signer) => signer.roleName === preferredWitnessRoleName,
    (signer) =>
      signer.roleName?.toLowerCase() === String(preferredWitnessRoleName).toLowerCase(),
    (signer) => /witness/i.test(signer.roleName || ""),
    (signer) => isDifferentFromPrimary(signer) && signer.routingOrder === "2",
    (signer) => isDifferentFromPrimary(signer),
  ];

  for (const match of matchers) {
    const found = signers.find((signer) => match(signer) && isDifferentFromPrimary(signer));
    if (found) return found;
  }

  const sorted = [...signers].sort(
    (a, b) => Number(a.routingOrder || 99) - Number(b.routingOrder || 99)
  );
  return sorted.find(isDifferentFromPrimary) || sorted[1] || null;
}

export function resolveConfiguredWitnessRoleName(template, primaryRoleName) {
  const { witnessRoleName } = getConfig();
  const witnessTemplate = resolveWitnessTemplateSigner(template, primaryRoleName, witnessRoleName);
  return witnessTemplate?.roleName || witnessRoleName;
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

  const matched =
    signers.find((signer) => signer.roleName === preferredRoleName) ||
    signers.find(
      (signer) =>
        signer.roleName?.toLowerCase() === String(preferredRoleName).toLowerCase()
    );
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

function normalizeTabLabel(tab) {
  return String(tab?.tabLabel || tab?.name || "")
    .replace(/[{}]/g, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isUnfilledTabValue(value) {
  const v = String(value || "").trim();
  if (!v || v === " ") return true;
  // Template placeholders like {{address}} must be replaced with real data.
  return /^\{\{[^}]+\}\}$/.test(v);
}

function isRequiredTab(tab) {
  return tab?.required === "true" || tab?.required === true;
}

function isAddressTab(tab) {
  const label = normalizeTabLabel(tab);
  if (!label || label.includes("email") || label.includes("e-mail")) return false;
  if (label === "address" || label === "addr") return true;
  const words = label.split(" ");
  return words.includes("address") && !words.includes("name");
}

export function extractSignupAddress(application, fallback = "") {
  const stage1 = application?.stage1Data;
  if (stage1 && typeof stage1 === "object" && !Array.isArray(stage1)) {
    if (typeof stage1.address === "string" && stage1.address.trim()) {
      return stage1.address.trim();
    }
  }
  return String(fallback || "").trim();
}

function isAgreementPartyTab(tab) {
  const label = normalizeTabLabel(tab);
  if (!label) return false;
  return (
    label.includes("agreement party") ||
    label.includes("party name") ||
    (label.includes("agreement") && label.includes("party"))
  );
}

function isAddressDocGenField(field) {
  const label = String(field?.label || field?.name || "")
    .replace(/[{}]/g, "")
    .replace(/[_/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!label || label.includes("email") || label.includes("e-mail")) return false;
  return label === "address" || label.includes("address");
}

async function populateEnvelopeDocGenFields(envelopeId, { address = "", name = "" } = {}) {
  if (!envelopeId || (!String(address).trim() && !String(name).trim())) return;

  let data;
  try {
    data = await docusignRequest(`/envelopes/${envelopeId}/docGenFormFields`);
  } catch (err) {
    console.warn("DocuSign document-generation fields lookup failed:", err?.message || err);
    return;
  }

  const docs = data.docGenFormFields || [];
  if (!docs.length) return;

  const payload = {
    docGenFormFields: docs
      .map((doc) => ({
        documentId: doc.documentId,
        docGenFormFieldList: (doc.docGenFormFieldList || [])
          .map((field) => {
            if (isAddressDocGenField(field) && String(address).trim()) {
              return { name: field.name, value: String(address).trim() };
            }
            if (
              isAgreementPartyTab({ tabLabel: field.label, name: field.name }) &&
              String(name).trim()
            ) {
              return { name: field.name, value: String(name).trim() };
            }
            return null;
          })
          .filter(Boolean),
      }))
      .filter((doc) => doc.documentId && doc.docGenFormFieldList.length > 0),
  };

  if (!payload.docGenFormFields.length) return;

  try {
    await docusignRequest(`/envelopes/${envelopeId}/docGenFormFields`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn("DocuSign document-generation address fill failed:", err?.message || err);
  }
}

export async function envelopeMissingSignupAddress(envelopeId, address) {
  if (!envelopeId || !String(address || "").trim()) return false;
  try {
    const data = await docusignRequest(`/envelopes/${envelopeId}/docGenFormFields`);
    const fields = (data.docGenFormFields || []).flatMap(
      (doc) => doc.docGenFormFieldList || []
    );
    const addressField = fields.find(isAddressDocGenField);
    if (!addressField) return false;
    return isUnfilledTabValue(addressField.value);
  } catch {
    return false;
  }
}

function resolveRequiredTextTabValue(tab, name, address = "", useTitleAsAddress = false) {
  const existing = tab.value || tab.originalValue;
  if (!isUnfilledTabValue(existing)) {
    return String(existing).trim();
  }

  if (isAddressTab(tab) || useTitleAsAddress) {
    return String(address || "").trim();
  }

  const label = normalizeTabLabel(tab);
  if (label.includes("agreement party") || label.includes("party name")) {
    return name;
  }
  if (label.includes("name") || label.includes("full name")) {
    return name;
  }
  if (label.includes("date")) {
    return new Date().toLocaleDateString("en-GB");
  }
  return name || "N/A";
}

function shouldPrefillTextTab(tab) {
  return isRequiredTab(tab) || isAddressTab(tab) || isAgreementPartyTab(tab);
}

function buildTemplateRole(signerTemplate, { email, name, clientUserId, address = "" }) {
  const role = {
    email,
    name,
    roleName: signerTemplate.roleName,
    clientUserId,
  };

  const textTabs = [];
  for (const tab of signerTemplate.tabs?.textTabs || []) {
    if (!shouldPrefillTextTab(tab)) continue;
    const value = resolveRequiredTextTabValue(tab, name, address);
    if (!value && isAddressTab(tab)) continue;
    textTabs.push({
      tabLabel: tab.tabLabel,
      value,
    });
  }

  if (textTabs.length > 0) {
    role.tabs = { textTabs };
  }

  return role;
}

function mapPrefillableTabs(list, { name, address = "", useTitleAsAddress = false } = {}) {
  return (list || [])
    .filter((tab) => useTitleAsAddress || shouldPrefillTextTab(tab))
    .filter((tab) => isUnfilledTabValue(tab.value))
    .map((tab) => ({
      tabId: tab.tabId,
      value: resolveRequiredTextTabValue(tab, name, address, useTitleAsAddress),
      ...(useTitleAsAddress ? { width: String(Math.max(Number(tab.width) || 0, 220)) } : {}),
    }))
    .filter((tab) => String(tab.value || "").trim());
}

async function prefillRecipientRequiredTextTabs(
  envelopeId,
  recipientId,
  { name, address = "", useTitleAsAddress = false } = {}
) {
  if (!recipientId || (!name?.trim() && !address?.trim())) return;

  const tabs = await docusignRequest(
    `/envelopes/${envelopeId}/recipients/${recipientId}/tabs`
  );
  const textTabs = mapPrefillableTabs(tabs.textTabs, { name, address });

  if (useTitleAsAddress && String(address || "").trim()) {
    await replaceTitleTabsWithAddressText(
      envelopeId,
      recipientId,
      tabs.titleTabs || [],
      String(address).trim()
    );
  } else {
    const titleTabs = mapPrefillableTabs(tabs.titleTabs, {
      name,
      address,
      useTitleAsAddress,
    });
    if (!textTabs.length && !titleTabs.length) return;
    await docusignRequest(`/envelopes/${envelopeId}/recipients/${recipientId}/tabs`, {
      method: "PUT",
      body: JSON.stringify({
        ...(textTabs.length ? { textTabs } : {}),
        ...(titleTabs.length ? { titleTabs } : {}),
      }),
    });
    return;
  }

  if (!textTabs.length) return;
  await docusignRequest(`/envelopes/${envelopeId}/recipients/${recipientId}/tabs`, {
    method: "PUT",
    body: JSON.stringify({ textTabs }),
  });
}

async function replaceTitleTabsWithAddressText(envelopeId, recipientId, titleTabs, address) {
  if (!titleTabs.length) return;

  const textTabs = titleTabs.map((tab, index) => ({
    documentId: String(tab.documentId || "1"),
    pageNumber: String(tab.pageNumber || "1"),
    xPosition: String(tab.xPosition ?? "90"),
    yPosition: String(tab.yPosition ?? "140"),
    width: String(Math.max(Number(tab.width) || 0, 220)),
    height: String(Math.max(Number(tab.height) || 0, 18)),
    tabLabel: tab.tabLabel || `witness-address-${index + 1}`,
    value: address,
    locked: "true",
    required: "false",
    font: tab.font || "arial",
    fontSize: tab.fontSize || "size12",
    bold: tab.bold || "false",
  }));

  try {
    await docusignRequest(`/envelopes/${envelopeId}/recipients/${recipientId}/tabs`, {
      method: "DELETE",
      body: JSON.stringify({
        titleTabs: titleTabs.map((tab) => ({ tabId: tab.tabId })),
      }),
    });
  } catch (err) {
    console.warn("DocuSign witness title tab remove failed:", err?.message || err);
  }

  await docusignRequest(`/envelopes/${envelopeId}/recipients/${recipientId}/tabs`, {
    method: "POST",
    body: JSON.stringify({ textTabs }),
  });
}

async function prefillDocumentAddressTabs(envelopeId, address) {
  const value = String(address || "").trim();
  if (!envelopeId || !value) return;

  try {
    const envelope = await docusignRequest(`/envelopes/${envelopeId}?include=documents`);
    const documents = envelope.envelopeDocuments || envelope.documents || [];
    for (const doc of documents) {
      const documentId = doc.documentId;
      if (!documentId) continue;

      const tabs = await docusignRequest(
        `/envelopes/${envelopeId}/documents/${documentId}/tabs`
      );
      const prefillTextTabs = (tabs.prefillTabs?.textTabs || [])
        .filter((tab) => isAddressTab(tab) && isUnfilledTabValue(tab.value))
        .map((tab) => ({ tabId: tab.tabId, value }));

      if (!prefillTextTabs.length) continue;

      await docusignRequest(`/envelopes/${envelopeId}/documents/${documentId}/tabs`, {
        method: "PUT",
        body: JSON.stringify({
          prefillTabs: { textTabs: prefillTextTabs },
        }),
      });
    }
  } catch (err) {
    console.warn("DocuSign address prefill tabs failed:", err?.message || err);
  }
}

async function ensureAnchoredAddressTab(envelopeId, recipientId, address) {
  const value = String(address || "").trim();
  if (!envelopeId || !recipientId || !value) return;

  try {
    const tabs = await docusignRequest(
      `/envelopes/${envelopeId}/recipients/${recipientId}/tabs`
    );
    const hasAddressTab = (tabs.textTabs || []).some(isAddressTab);
    if (hasAddressTab) return;

    await docusignRequest(`/envelopes/${envelopeId}/recipients/${recipientId}/tabs`, {
      method: "POST",
      body: JSON.stringify({
        textTabs: [
          {
            tabLabel: "address",
            value,
            locked: "true",
            anchorString: "{{address}}",
            anchorIgnoreIfNotPresent: "true",
            anchorCaseSensitive: "false",
            anchorMatchWholeWord: "true",
          },
        ],
      }),
    });
  } catch (err) {
    console.warn("DocuSign anchored address tab failed:", err?.message || err);
  }
}

async function prefillEnvelopeRequiredTextTabs(
  envelopeId,
  { primaryName, primaryAddress = "", witnessName, witnessAddress = "" } = {}
) {
  const signers = await getEnvelopeSigners(envelopeId);
  const primary = signers.find((s) => s.routingOrder === "1") || signers[0];
  const witness =
    signers.find((s) => s.routingOrder === "2" && s.recipientId !== primary?.recipientId) ||
    signers.find((s) => s.recipientId !== primary?.recipientId);

  if (primary?.recipientId && (primaryName || primaryAddress)) {
    await prefillRecipientRequiredTextTabs(envelopeId, primary.recipientId, {
      name: primaryName,
      address: primaryAddress,
    });
    await ensureAnchoredAddressTab(envelopeId, primary.recipientId, primaryAddress);
  }
  if (witness?.recipientId && (witnessName || witnessAddress)) {
    await prefillRecipientRequiredTextTabs(envelopeId, witness.recipientId, {
      name: witnessName,
      address: witnessAddress,
      useTitleAsAddress: true,
    });
  }
  if (primaryAddress) {
    await prefillDocumentAddressTabs(envelopeId, primaryAddress);
  }
}

async function getEnvelopeSigners(envelopeId) {
  const envelope = await docusignRequest(`/envelopes/${envelopeId}?include=recipients`);
  return envelope.recipients?.signers || [];
}

export async function cleanupStaleEnvelopeRecipients(
  envelopeId,
  { activeWitnessEmail } = {}
) {
  const signers = await getEnvelopeSigners(envelopeId);
  if (!signers.length) return { removed: 0 };

  const primary = signers.find((s) => s.routingOrder === "1") || signers[0];
  const activeEmail = activeWitnessEmail?.trim().toLowerCase();
  const nonPrimary = signers.filter(
    (signer) =>
      signer.recipientId &&
      String(signer.recipientId) !== String(primary?.recipientId)
  );
  let removed = 0;

  for (const signer of nonPrimary) {
    const email = (signer.email || "").toLowerCase();
    if (activeEmail && email === activeEmail) continue;

    const isPlaceholder = email.includes("@fipo-sign.local");
    const isWitnessSlot =
      String(signer.routingOrder || "") === "2" ||
      /witness/i.test(String(signer.roleName || ""));
    const done = isSignerDone(signer.status);

    // Keep the single witness placeholder — Stage 2 updates it in place.
    // Deleting it after the claimant signs makes DocuSign mark the envelope
    // COMPLETED and blocks witness signing.
    if (isWitnessSlot && nonPrimary.length === 1) {
      continue;
    }

    // Only remove extra junk recipients (old templates / duplicates), never the
    // sole pending witness slot.
    if (!done && (signers.length > 2 || (isPlaceholder && nonPrimary.length > 1))) {
      try {
        await docusignRequest(`/envelopes/${envelopeId}/recipients/${signer.recipientId}`, {
          method: "DELETE",
        });
        removed++;
      } catch (err) {
        console.warn("Could not remove stale DocuSign recipient:", err.message);
      }
    }
  }

  if (removed > 0) {
    clearEnvelopeStatusCache(envelopeId);
  }

  return { removed };
}

export async function createSenderView(envelopeId, returnUrl) {
  const view = await docusignRequest(`/envelopes/${envelopeId}/views/sender`, {
    method: "POST",
    body: JSON.stringify({ returnUrl }),
  });
  return view.url;
}

function pickPrimaryEnvelopeSigner(signers, preferredRoleName) {
  if (!signers?.length) return null;
  return (
    signers.find((signer) => signer.routingOrder === "1") ||
    signers.find((signer) => signer.roleName === preferredRoleName) ||
    signers.find(
      (signer) =>
        signer.roleName?.toLowerCase() === String(preferredRoleName).toLowerCase()
    ) ||
    signers.find((signer) => (signer.tabs?.signHereTabs || []).length > 0) ||
    signers[0]
  );
}

async function resolvePrimaryEnvelopeSigner(envelopeId, preferredRoleName) {
  let signers = await getEnvelopeSigners(envelopeId);
  if (!signers.length) {
    const err = new Error("DocuSign envelope has no signers after creation.");
    err.code = "ENVELOPE_NO_SIGNERS";
    throw err;
  }

  let primary = pickPrimaryEnvelopeSigner(signers, preferredRoleName);
  if (!primary?.recipientId) {
    signers = await getEnvelopeSigners(envelopeId);
    primary = pickPrimaryEnvelopeSigner(signers, preferredRoleName);
  }

  if (!primary?.recipientId) {
    const err = new Error("Could not locate the primary signer on this DocuSign envelope.");
    err.code = "ENVELOPE_NO_PRIMARY_SIGNER";
    throw err;
  }

  return { primary, signers };
}

function nextRecipientId(signers) {
  const ids = (signers || [])
    .map((signer) => Number.parseInt(String(signer.recipientId || "0"), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

function sanitizeSignHereTabs(tabs) {
  return (tabs || []).map((tab, index) => ({
    documentId: String(tab.documentId || "1"),
    pageNumber: String(tab.pageNumber || "1"),
    xPosition: String(tab.xPosition ?? "100"),
    yPosition: String(tab.yPosition ?? "500"),
    tabLabel: tab.tabLabel || `Witness Signature ${index + 1}`,
  }));
}

async function normalizeEnvelopeSigner(
  envelopeId,
  { email, name, clientUserId },
  { preserveAdditionalSigners = false } = {}
) {
  const { roleName } = getConfig();
  const { primary, signers } = await resolvePrimaryEnvelopeSigner(envelopeId, roleName);

  const targetEmail = email.toLowerCase();
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
            recipientId: String(primary.recipientId),
            email,
            name,
            clientUserId,
            roleName: primary.roleName || roleName,
          },
        ],
      }),
    });
  }

  if (preserveAdditionalSigners) return;

  for (const signer of signers) {
    if (!signer.recipientId || signer.recipientId === primary.recipientId) continue;
    await docusignRequest(`/envelopes/${envelopeId}/recipients/${signer.recipientId}`, {
      method: "DELETE",
    });
  }
}

async function ensureWitnessSignTabs(envelopeId) {
  const { roleName, witnessRoleName } = getConfig();
  const template = await getTemplateDetails();
  const resolvedWitnessRoleName = resolveConfiguredWitnessRoleName(template, roleName);
  const { primary } = await resolvePrimaryEnvelopeSigner(envelopeId, roleName);
  const signers = await getEnvelopeSigners(envelopeId);
  const witness = findWitnessSigner(signers, resolvedWitnessRoleName, roleName);
  if (!witness?.recipientId) return;

  const witnessTabs = await getRecipientSignHereTabs(envelopeId, witness.recipientId);
  if (witnessTabs.length > 0) return;

  const witnessTemplate = resolveWitnessTemplateSigner(
    template,
    roleName,
    resolvedWitnessRoleName
  );
  const templateTabs = sanitizeSignHereTabs(witnessTemplate?.tabs?.signHereTabs || []);
  const signHereTabs =
    templateTabs.length > 0
      ? templateTabs
      : await buildWitnessSignHereTabs(envelopeId, primary.recipientId);

  await docusignRequest(`/envelopes/${envelopeId}/recipients/${witness.recipientId}/tabs`, {
    method: "POST",
    body: JSON.stringify({ signHereTabs }),
  });
}

export async function createEnvelopeFromTemplate({
  signerEmail,
  signerName,
  signerAddress = "",
  clientUserId,
  documents = [],
}) {
  const { templateId, roleName, witnessRoleName } = getConfig();
  const template = await getTemplateDetails();

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
    address: signerAddress,
  });

  const witnessTemplate = resolveWitnessTemplateSigner(template, roleName, witnessRoleName);
  const templateRoles = [templateRole];

  if (witnessTemplate) {
    const safeId = String(clientUserId || "pending").replace(/[^a-zA-Z0-9]/g, "");
    templateRoles.push(
      buildTemplateRole(witnessTemplate, {
        email: `witness.pending.${safeId}@fipo-sign.local`,
        name: "Witness (pending)",
        clientUserId: `witness-${clientUserId}`,
      })
    );
  }

  const preserveAdditionalSigners = templateRoles.length > 1;

  const createBody = {
    emailSubject: template.emailSubject || "Please sign your FIPO legal documents",
    templateId,
    templateRoles,
    status: "created",
  };
  const eventNotification = buildEnvelopeEventNotification();
  if (eventNotification) {
    createBody.eventNotification = eventNotification;
  }

  const envelope = await docusignRequest("/envelopes", {
    method: "POST",
    body: JSON.stringify(createBody),
  });

  if (signerAddress) {
    try {
      await docusignRequest(`/envelopes/${envelope.envelopeId}/custom_fields`, {
        method: "POST",
        body: JSON.stringify({
          textCustomFields: [
            { name: "address", value: signerAddress, show: "false" },
          ],
        }),
      });
    } catch (err) {
      console.warn("DocuSign address custom field failed:", err?.message || err);
    }
  }

  await normalizeEnvelopeSigner(
    envelope.envelopeId,
    {
      email: signerEmail,
      name: signerName,
      clientUserId,
    },
    { preserveAdditionalSigners }
  );

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

  if (!witnessTemplate) {
    const safeId = String(clientUserId || "pending").replace(/[^a-zA-Z0-9]/g, "");
    await addDynamicWitnessRecipient(envelope.envelopeId, {
      email: `witness.pending.${safeId}@fipo-sign.local`,
      name: "Witness (pending)",
      clientUserId: `witness-${clientUserId}`,
    });
  } else {
    await ensureWitnessSignTabs(envelope.envelopeId);
  }

  await prefillEnvelopeRequiredTextTabs(envelope.envelopeId, {
    primaryName: signerName,
    primaryAddress: signerAddress,
  });
  await populateEnvelopeDocGenFields(envelope.envelopeId, {
    address: signerAddress,
    name: signerName,
  });

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
  signerAddress = "",
  clientUserId,
  returnUrl,
}) {
  const { roleName } = getConfig();
  const signers = await getEnvelopeSigners(envelopeId);
  const primary =
    signers.find((signer) => clientUserId && signer.clientUserId === clientUserId) ||
    pickPrimaryEnvelopeSigner(signers, roleName) ||
    signers.find(
      (signer) => (signer.email || "").toLowerCase() === signerEmail.toLowerCase()
    );

  await prefillEnvelopeRequiredTextTabs(envelopeId, {
    primaryName: signerName,
    primaryAddress: signerAddress,
    witnessName: signers.find((s) => s.routingOrder === "2")?.name,
  });

  const viewRequest = {
    returnUrl,
    authenticationMethod: "none",
    email: signerEmail,
    userName: signerName,
    clientUserId,
  };
  if (primary?.recipientId) {
    viewRequest.recipientId = String(primary.recipientId);
  }

  const view = await docusignRequest(`/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    body: JSON.stringify(viewRequest),
  });

  return view.url;
}

function isSignerDone(status) {
  const normalised = String(status || "").toLowerCase();
  return (
    normalised === "completed" ||
    normalised === "signed" ||
    normalised === "autoresponded"
  );
}

function findWitnessSigner(signers, witnessRoleName, primaryRoleName) {
  if (!signers?.length || signers.length <= 1) return null;
  const primary =
    signers.find((signer) => signer.routingOrder === "1") || signers[0];

  const candidates = signers.filter((signer) => {
    if (signer.routingOrder === "1") return false;
    if (
      primary?.email &&
      signer.email &&
      primary.email.toLowerCase() === signer.email.toLowerCase()
    ) {
      return false;
    }
    if (primary?.roleName && signer.roleName === primary.roleName && signers.length <= 2) {
      return signer.routingOrder === "2" || /witness/i.test(signer.roleName || "");
    }
    return true;
  });

  if (!candidates.length) return null;

  return (
    candidates.find((signer) => signer.roleName === witnessRoleName) ||
    candidates.find(
      (signer) =>
        signer.roleName?.toLowerCase() === String(witnessRoleName).toLowerCase()
    ) ||
    candidates.find((signer) => /witness/i.test(signer.roleName || "")) ||
    candidates.find((signer) => signer.routingOrder === "2") ||
    candidates.find((signer) => signer.roleName !== primaryRoleName) ||
    null
  );
}

export function pickWitnessRemoteSigner(signers, { witnessEmail, witnessRoleName } = {}) {
  const primaryRoleName = getConfig().roleName;
  const resolvedRoleName = witnessRoleName || getConfig().witnessRoleName;
  const witness = findWitnessSigner(signers, resolvedRoleName, primaryRoleName);
  if (!witness) return null;
  if (
    witnessEmail &&
    witness.email &&
    witness.email.toLowerCase() !== witnessEmail.trim().toLowerCase()
  ) {
    const byEmail = (signers || []).find(
      (signer) =>
        signer.routingOrder !== "1" &&
        signer.email?.toLowerCase() === witnessEmail.trim().toLowerCase()
    );
    return byEmail || witness;
  }
  return witness;
}

async function getRecipientSignHereTabs(envelopeId, recipientId) {
  const data = await docusignRequest(
    `/envelopes/${envelopeId}/recipients/${recipientId}/tabs`
  );
  return data.signHereTabs || [];
}

async function buildWitnessSignHereTabs(envelopeId, primaryRecipientId) {
  const primaryTabs = await getRecipientSignHereTabs(envelopeId, primaryRecipientId);
  const yOffset = Number(process.env.DOCUSIGN_WITNESS_SIGN_Y_OFFSET || 120);

  if (primaryTabs.length > 0) {
    return sanitizeSignHereTabs(
      primaryTabs.map((tab, index) => ({
        documentId: tab.documentId,
        pageNumber: tab.pageNumber,
        xPosition: tab.xPosition,
        yPosition: String(Number(tab.yPosition) + yOffset),
        tabLabel: tab.tabLabel ? `Witness ${tab.tabLabel}` : `Witness Signature ${index + 1}`,
      }))
    );
  }

  return sanitizeSignHereTabs([
    {
      documentId: process.env.DOCUSIGN_WITNESS_DOCUMENT_ID || "1",
      pageNumber: process.env.DOCUSIGN_WITNESS_SIGN_PAGE || "1",
      xPosition: process.env.DOCUSIGN_WITNESS_SIGN_X || "100",
      yPosition: process.env.DOCUSIGN_WITNESS_SIGN_Y || "500",
      tabLabel: "Witness Signature",
    },
  ]);
}

async function addDynamicWitnessRecipient(
  envelopeId,
  { email, name, address = "", routingOrder = "2", clientUserId }
) {
  const { roleName, witnessRoleName } = getConfig();
  const { primary, signers } = await resolvePrimaryEnvelopeSigner(envelopeId, roleName);

  const existingWitness = findWitnessSigner(signers, witnessRoleName, roleName);
  if (existingWitness?.recipientId) {
    const witnessTabs = await getRecipientSignHereTabs(
      envelopeId,
      existingWitness.recipientId
    );
    if (witnessTabs.length === 0) {
      const signHereTabs = await buildWitnessSignHereTabs(envelopeId, primary.recipientId);
      await docusignRequest(
        `/envelopes/${envelopeId}/recipients/${existingWitness.recipientId}/tabs`,
        {
          method: "POST",
          body: JSON.stringify({ signHereTabs }),
        }
      );
    }
    return existingWitness.recipientId;
  }

  const recipientId = nextRecipientId(signers);
  const signHereTabs = await buildWitnessSignHereTabs(envelopeId, primary.recipientId);

  // DocuSign requires an explicit recipientId when adding signers to an envelope.
  await docusignRequest(`/envelopes/${envelopeId}/recipients`, {
    method: "POST",
    body: JSON.stringify({
      signers: [
        {
          recipientId,
          email,
          name,
          routingOrder: String(routingOrder),
          roleName: witnessRoleName,
          ...(address ? { title: address } : {}),
          ...(clientUserId ? { clientUserId } : {}),
        },
      ],
    }),
  });

  await docusignRequest(`/envelopes/${envelopeId}/recipients/${recipientId}/tabs`, {
    method: "POST",
    body: JSON.stringify({ signHereTabs }),
  });

  return recipientId;
}

export async function assignWitnessRecipient(
  envelopeId,
  { email, name, address = "", clientUserId }
) {
  const { roleName, witnessRoleName } = getConfig();
  clearEnvelopeStatusCache(envelopeId);

  // Check status first — never mutate recipients on a completed envelope.
  const envelopeStatus = await getEnvelopeStatus(envelopeId, { forceRefresh: true });
  if (envelopeStatus.status === "COMPLETED") {
    const template = await getTemplateDetails();
    const resolvedWitnessRoleName = resolveConfiguredWitnessRoleName(template, roleName);
    const witnessOnEnvelope = pickWitnessRemoteSigner(envelopeStatus.signers, {
      witnessEmail: email,
      witnessRoleName: resolvedWitnessRoleName,
    });
    const witnessAlreadyDone =
      witnessOnEnvelope && isSignerDone(witnessOnEnvelope.status);
    if (!witnessAlreadyDone) {
      const err = new Error(
        "This document was already fully signed without a witness slot. Click Sign again in Stage 1 to start a fresh envelope with witness signing."
      );
      err.code = "ENVELOPE_ALREADY_COMPLETED";
      throw err;
    }
    return;
  }

  await cleanupStaleEnvelopeRecipients(envelopeId, { activeWitnessEmail: email });
  const signers = await getEnvelopeSigners(envelopeId);
  const primary =
    signers.find((signer) => signer.routingOrder === "1") || signers[0];
  const template = await getTemplateDetails();
  const resolvedWitnessRoleName = resolveConfiguredWitnessRoleName(template, roleName);

  if (primary && !isSignerDone(primary.status)) {
    const err = new Error("The claimant must finish signing before the witness can sign.");
    err.code = "CLAIMANT_SIGNING_INCOMPLETE";
    throw err;
  }

  let witness = findWitnessSigner(signers, resolvedWitnessRoleName, roleName);

  const runAssign = async () => {
    if (!witness) {
      await addDynamicWitnessRecipient(envelopeId, { email, name, address, clientUserId });
      await ensureWitnessSignTabs(envelopeId);
      await prefillEnvelopeRequiredTextTabs(envelopeId, {
        primaryName: primary?.name,
        witnessName: name,
        witnessAddress: address,
      });
      return;
    }

    if (!witness.recipientId) {
      const refreshed = await getEnvelopeSigners(envelopeId);
      witness = findWitnessSigner(refreshed, resolvedWitnessRoleName, roleName);
    }

    if (!witness?.recipientId) {
      await addDynamicWitnessRecipient(envelopeId, { email, name, address, clientUserId });
      await ensureWitnessSignTabs(envelopeId);
      await prefillEnvelopeRequiredTextTabs(envelopeId, {
        primaryName: primary?.name,
        witnessName: name,
        witnessAddress: address,
      });
      return;
    }

    await docusignRequest(`/envelopes/${envelopeId}/recipients`, {
      method: "PUT",
      body: JSON.stringify({
        signers: [
          {
            recipientId: String(witness.recipientId),
            email,
            name,
            ...(address ? { title: address } : {}),
            roleName: witness.roleName || resolvedWitnessRoleName,
            ...(clientUserId ? { clientUserId } : {}),
          },
        ],
      }),
    });

    await ensureWitnessSignTabs(envelopeId);
    await prefillEnvelopeRequiredTextTabs(envelopeId, {
      primaryName: signers.find((s) => s.routingOrder === "1")?.name,
      witnessName: name,
      witnessAddress: address,
    });
  };

  try {
    await runAssign();
  } catch (err) {
    if (
      err.code === "ENVELOPE_ALREADY_COMPLETED" ||
      /invalid envelope status/i.test(String(err.message || ""))
    ) {
      const mapped = new Error(
        "This document was already fully signed without a witness slot. Click Sign again in Stage 1 to start a fresh envelope with witness signing."
      );
      mapped.code = "ENVELOPE_ALREADY_COMPLETED";
      throw mapped;
    }
    throw err;
  }
}

export async function createWitnessRecipientView({
  envelopeId,
  witnessEmail,
  witnessName,
  witnessAddress = "",
  witnessClientUserId,
  returnUrl,
}) {
  await ensureWitnessSignTabs(envelopeId);

  const { roleName, witnessRoleName } = getConfig();
  const template = await getTemplateDetails();
  const resolvedWitnessRoleName = resolveConfiguredWitnessRoleName(template, roleName);
  const signers = await getEnvelopeSigners(envelopeId);
  const primary =
    signers.find((signer) => signer.routingOrder === "1") || signers[0];
  const witness =
    pickWitnessRemoteSigner(signers, {
      witnessEmail,
      witnessRoleName: resolvedWitnessRoleName,
    }) || findWitnessSigner(signers, resolvedWitnessRoleName, roleName);

  await prefillEnvelopeRequiredTextTabs(envelopeId, {
    primaryName: primary?.name,
    witnessName: witnessName,
    witnessAddress,
  });

  const viewRequest = {
    returnUrl,
    authenticationMethod: witnessClientUserId ? "none" : "email",
    email: witnessEmail,
    userName: witnessName,
  };
  if (witnessClientUserId) {
    viewRequest.clientUserId = witnessClientUserId;
  }
  if (witness?.recipientId) {
    viewRequest.recipientId = String(witness.recipientId);
  }

  const view = await docusignRequest(`/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    body: JSON.stringify(viewRequest),
  });

  return view.url;
}

export async function getEnvelopeStatus(envelopeId, options = {}) {
  const { forceRefresh = false } = options;
  if (!envelopeId || String(envelopeId).startsWith("stub_")) {
    return {
      status: null,
      completedDateTime: null,
      signers: [],
      multipleSigners: false,
      pendingSigners: [],
      allSignersCompleted: false,
    };
  }

  const cacheKey = String(envelopeId);
  if (!forceRefresh) {
    const cached = envelopeStatusCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data;
    }
  }

  let envelope;
  try {
    envelope = await docusignRequest(`/envelopes/${cacheKey}?include=recipients`);
  } catch (err) {
    if (err.rateLimited) {
      const cached = envelopeStatusCache.get(cacheKey);
      if (cached) return cached.data;
    }
    throw err;
  }

  const raw = String(envelope.status || "").toUpperCase();
  const statusMap = {
    SENT: "SENT",
    DELIVERED: "DELIVERED",
    COMPLETED: "COMPLETED",
    DECLINED: "DECLINED",
  };

  const isSignerDoneLocal = (status) => isSignerDone(status);

  const signers = (envelope.recipients?.signers || []).map((signer) => ({
    name: signer.name,
    email: signer.email,
    status: String(signer.status || ""),
    roleName: signer.roleName || null,
    routingOrder: signer.routingOrder || null,
    recipientId: signer.recipientId || null,
  }));

  const pendingSigners = signers.filter((signer) => !isSignerDoneLocal(signer.status));
  const multipleSigners = signers.length > 1;

  const allSignersCompleted =
    signers.length > 0 && signers.every((signer) => isSignerDoneLocal(signer.status));

  const mapped = statusMap[raw] || raw;
  // Use DocuSign envelope status; completedDateTime means the PDF is finalized.
  const status =
    mapped === "COMPLETED" || envelope.completedDateTime ? "COMPLETED" : mapped;

  const result = {
    status,
    completedDateTime: envelope.completedDateTime || null,
    signers,
    multipleSigners,
    pendingSigners,
    allSignersCompleted,
  };

  const ttl =
    status === "COMPLETED"
      ? ENVELOPE_STATUS_CACHE_COMPLETED_MS
      : ENVELOPE_STATUS_CACHE_MS;
  envelopeStatusCache.set(cacheKey, {
    data: result,
    expiresAt: Date.now() + ttl,
  });

  return result;
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
