import { createApiApp } from "./server.ts";

const app = createApiApp();

export default function handler(req: any, res: any) {
  return app(req, res);
}
