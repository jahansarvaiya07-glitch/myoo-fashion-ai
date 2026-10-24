import { handleRequest } from "../server.mjs";

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

export default async function handler(req, res) {
  req.url = "/api/scan-cloth";
  await handleRequest(req, res);
}
