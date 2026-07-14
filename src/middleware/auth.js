import jwt from "jsonwebtoken";

function extractToken(req) {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing");
  return jwt.verify(token, secret);
}

/** Any authenticated user (USER, ADMIN, SUPER_ADMIN). */
export function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** ADMIN or SUPER_ADMIN only. */
export function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = verifyToken(token);
    if (payload.role !== "ADMIN" && payload.role !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** SUPER_ADMIN only. */
export function requireSuperAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = verifyToken(token);
    if (payload.role !== "SUPER_ADMIN") {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
