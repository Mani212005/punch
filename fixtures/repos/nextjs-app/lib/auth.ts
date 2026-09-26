import jwt from "jsonwebtoken";

export function verifyToken(token: string, secret: string): unknown {
  // Call site: jwt.verify
  return jwt.verify(token, secret);
}

export function decodeToken(token: string): unknown {
  // Call site: jwt.decode
  return jwt.decode(token);
}
