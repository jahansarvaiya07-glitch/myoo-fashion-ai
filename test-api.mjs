import { readFile } from "node:fs/promises";

async function test() {
  console.log("--- 1. Health ---");
  const health = await fetch("http://localhost:4173/api/health").then(r => r.json());
  console.log("Health:", health);

  console.log("\n--- 2. Scan Cloth ---");
  const img = await readFile("d:/0001vscode-outputs/myoo folder/Zardozi Maroon Lehenga.jpg");
  const form = new FormData();
  form.append("clothImage", new Blob([img], { type: "image/jpeg" }), "Zardozi Maroon Lehenga.jpg");

  const scanRes = await fetch("http://localhost:4173/api/scan-cloth", {
    method: "POST",
    body: form
  });
  console.log("Scan status:", scanRes.status);
  const scanData = await scanRes.json();
  console.log("Scan result:", JSON.stringify(scanData, null, 2));

  console.log("\n--- 3. Chat Stylist ---");
  const chatRes = await fetch("http://localhost:4173/api/chat-stylist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "What kind of jewelry would you recommend with this lehenga?",
      clothContext: `Garment: ${scanData?.scan?.garmentType}, Fabrics: ${scanData?.scan?.fabrics}, Colors: ${scanData?.scan?.visibleColors?.join(", ")}`
    })
  });
  console.log("Chat status:", chatRes.status);
  const chatData = await chatRes.json();
  console.log("Chat reply:", chatData);
}

test().catch(console.error);
