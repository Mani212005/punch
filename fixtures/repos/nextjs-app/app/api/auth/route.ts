import { verifyToken } from "../../../lib/auth.js";

export async function POST(request: Request) {
  const body = await request.json();
  const token = body.token || "";
  try {
    const user = verifyToken(token, "secret123");
    return Response.json({ authenticated: true, user });
  } catch {
    return Response.json({ authenticated: false }, { status: 401 });
  }
}

export async function GET() {
  return Response.json({ status: "auth-endpoint-active" });
}
