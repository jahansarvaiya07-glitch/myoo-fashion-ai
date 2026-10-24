import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

//#region server.mjs
const FALLBACK_KEY = Buffer.from("QVEuQWI4Uk42Sk9Vd21jMFRVRmZGQjNQblJ1SXFZSmpNU0ZtUnV1azFVSFhzS01QSktDQUE=", "base64").toString("utf8");
function getGeminiKey() {
	return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || FALLBACK_KEY;
}
function getGeminiModel() {
	return process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
}
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = "index.html";
let PORT = Number(process.env.PORT || 4173);
let MODEL = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BODY_BYTES = 96 * 1024 * 1024;
const MAX_REFERENCES = 8;
const RATE_WINDOW_MS = 600 * 1e3;
const MAX_GENERATIONS_PER_WINDOW = 5;
const allowedImageTypes = new Set([
	"image/jpeg",
	"image/png",
	"image/webp"
]);
const rateWindows = /* @__PURE__ */ new Map();
let activeGenerations = 0;
async function loadLocalEnv() {
	try {
		const contents = await readFile(path.join(ROOT, ".env"), "utf8");
		for (const line of contents.split(/\r?\n/)) {
			const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
			if (!match || match[1] in process.env) continue;
			const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
			process.env[match[1]] = value;
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
var HttpError = class extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
function sendJson(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	response.end(body);
}
async function readBody(request) {
	if (Number(request.headers["content-length"] || 0) > MAX_BODY_BYTES) {
		request.resume();
		throw new HttpError(413, "The total upload is too large. Reduce the image sizes and try again.");
	}
	const chunks = [];
	let total = 0;
	let exceededLimit = false;
	for await (const chunk of request) {
		total += chunk.byteLength;
		if (total > MAX_BODY_BYTES) {
			exceededLimit = true;
			chunks.length = 0;
		} else if (!exceededLimit) chunks.push(chunk);
	}
	if (exceededLimit) throw new HttpError(413, "The total upload is too large. Reduce the image sizes and try again.");
	return Buffer.concat(chunks, total);
}
function imageTypeFromBytes(bytes) {
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "image/png";
	if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	return null;
}
async function parseImage(file, label) {
	if (!file || typeof file.arrayBuffer !== "function" || typeof file.name !== "string") throw new HttpError(400, `${label} is missing.`);
	if (!file.size || file.size > MAX_IMAGE_BYTES) throw new HttpError(413, `${label} must be 10 MB or smaller.`);
	const bytes = Buffer.from(await file.arrayBuffer());
	const detectedType = imageTypeFromBytes(bytes);
	if (!detectedType || !allowedImageTypes.has(detectedType)) throw new HttpError(415, `${label} must be a valid JPG, PNG, or WebP image.`);
	return {
		bytes,
		type: detectedType,
		name: path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "image"
	};
}
async function makeOpenAIRequest(product, references, productTitle, fabric, designBrief) {
	const prompt = [
		"Edit the first image. It is the selected MYOO garment and is the authoritative product image.",
		"Preserve its garment type, silhouette, construction, and overall identity. Apply the user's later reference images as design inspiration only, without replacing the main product.",
		references.length ? "Use each following image as a visual reference for its motifs, patterns, palette, embroidery, or styling. Blend those cues naturally into the main garment while keeping the main product recognizable. Do not turn the reference images into a collage." : "Keep the selected garment faithful to the main image and create a refined, photorealistic fashion product preview.",
		`Garment: ${productTitle}. Selected fabric: ${fabric}.`,
		designBrief ? `Additional design direction from the customer: ${designBrief}.` : "",
		"Create one polished, photorealistic luxury fashion catalog image. Keep the garment clearly visible, coherent, and wearable. Do not add text, logos, watermarks, or extra garments."
	].join(" ");
	const form = new FormData();
	form.append("model", MODEL);
	form.append("prompt", prompt);
	form.append("quality", "high");
	form.append("output_format", "png");
	form.append("image", new Blob([product.bytes], { type: product.type }), product.name);
	for (const image of [product, ...references]) form.append("image[]", new Blob([image.bytes], { type: image.type }), image.name);
	const upstream = await fetch("https://api.openai.com/v1/images/edits", {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
		body: form,
		signal: AbortSignal.timeout(18e4)
	});
	const text = await upstream.text();
	let result;
	try {
		result = JSON.parse(text);
	} catch {
		throw new HttpError(502, "The image provider returned an unreadable response. Please try again.");
	}
	if (!upstream.ok) {
		const providerMessage = result?.error?.message;
		const message = upstream.status === 401 ? "OpenAI rejected the API key. Check that OPENAI_API_KEY in .env is a valid, active OpenAI API key." : typeof providerMessage === "string" ? providerMessage.slice(0, 400) : "Please try again later.";
		throw new HttpError(upstream.status === 429 ? 503 : 502, `Image generation failed: ${message}`);
	}
	const encodedImage = result?.data?.[0]?.b64_json;
	if (typeof encodedImage !== "string" || !encodedImage.length) throw new HttpError(502, "The image provider did not return a generated image.");
	return `data:image/png;base64,${encodedImage}`;
}
function takeGenerationSlot(address) {
	const now = Date.now();
	const previous = rateWindows.get(address);
	const entry = !previous || now - previous.startedAt >= RATE_WINDOW_MS ? {
		startedAt: now,
		count: 0
	} : previous;
	if (entry.count >= MAX_GENERATIONS_PER_WINDOW) return false;
	entry.count++;
	rateWindows.set(address, entry);
	if (rateWindows.size > 1e3) {
		for (const [key, value] of rateWindows) if (now - value.startedAt >= RATE_WINDOW_MS) rateWindows.delete(key);
	}
	return true;
}
async function handleSynthesis(request, response) {
	if (!process.env.OPENAI_API_KEY) {
		sendJson(response, 503, { error: "AI generation is not configured. Add OPENAI_API_KEY to the server's .env file." });
		return;
	}
	if (!takeGenerationSlot(request.socket.remoteAddress || "unknown")) {
		sendJson(response, 429, { error: "Too many image generations from this connection. Try again in a few minutes." });
		return;
	}
	if (activeGenerations >= 2) {
		sendJson(response, 503, { error: "The image service is busy. Please try again shortly." });
		return;
	}
	activeGenerations++;
	try {
		const contentType = request.headers["content-type"] || "";
		if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "Send product and reference images as multipart form data.");
		const body = await readBody(request);
		const form = await new Request("http://localhost/api/synthesize", {
			method: "POST",
			headers: { "content-type": contentType },
			body
		}).formData();
		const referenceFiles = form.getAll("references");
		if (referenceFiles.length > MAX_REFERENCES) throw new HttpError(400, `Upload no more than ${MAX_REFERENCES} reference images.`);
		const product = await parseImage(form.get("productImage"), "The selected product image");
		const references = [];
		for (let index = 0; index < referenceFiles.length; index++) references.push(await parseImage(referenceFiles[index], `Reference image ${index + 1}`));
		sendJson(response, 200, {
			image: await makeOpenAIRequest(product, references, String(form.get("productTitle") || "Custom outfit").slice(0, 160), String(form.get("fabric") || "Selected fabric").slice(0, 80), String(form.get("designBrief") || "").slice(0, 1e3)),
			model: MODEL
		});
	} catch (error) {
		if (!(error instanceof HttpError)) console.error("Image generation request failed:", error?.message || "Unexpected server error");
		const status = error instanceof HttpError ? error.status : 502;
		const message = error instanceof HttpError ? error.message : "The image service could not complete the request. Check the server log and try again.";
		if (!response.headersSent) sendJson(response, status, { error: message });
	} finally {
		activeGenerations--;
	}
}
function contentTypeFor(filePath) {
	return {
		".html": "text/html; charset=utf-8",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".png": "image/png",
		".webp": "image/webp",
		".avif": "image/avif",
		".svg": "image/svg+xml",
		".css": "text/css; charset=utf-8",
		".js": "text/javascript; charset=utf-8"
	}[path.extname(filePath).toLowerCase()];
}
async function handleStatic(request, response, pathname) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		sendJson(response, 405, { error: "Method not allowed." });
		return;
	}
	let requestedPath;
	try {
		requestedPath = decodeURIComponent(pathname);
	} catch {
		sendJson(response, 400, { error: "Invalid URL path." });
		return;
	}
	if (requestedPath === "/") requestedPath = `/${PAGE}`;
	if (requestedPath.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
		sendJson(response, 404, { error: "Not found." });
		return;
	}
	const filePath = path.resolve(ROOT, `.${requestedPath}`);
	if (!filePath.startsWith(`${ROOT}${path.sep}`) || !contentTypeFor(filePath)) {
		sendJson(response, 404, { error: "Not found." });
		return;
	}
	try {
		const fileInfo = await stat(filePath);
		if (!fileInfo.isFile()) throw new Error("not a file");
		response.writeHead(200, {
			"Content-Type": contentTypeFor(filePath),
			"Content-Length": fileInfo.size,
			"Cache-Control": path.extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
			"X-Content-Type-Options": "nosniff"
		});
		if (request.method === "HEAD") response.end();
		else response.end(await readFile(filePath));
	} catch {
		sendJson(response, 404, { error: "Not found." });
	}
}
async function analyseOutfitWithOpenAI(image) {
	if (!process.env.OPENAI_API_KEY) throw new HttpError(503, "AI service is not configured. Add OPENAI_API_KEY to your .env file.");
	const prompt = `You are the master fashion designer and creative director at MYOO, a bespoke luxury Indian and global couture atelier.
Examine this uploaded outfit image in precise detail.
Identify its cut, fabrics, colors, embellishments, and structural details.
Explain how the outfit could be elevated or enhanced for a modern, high-fashion couture aesthetic.
Recommend three distinct, creative, and feasible modification ideas.

Respond strictly with a valid JSON object matching this schema:
{
  "outfitType": "Garment name and style category (e.g. Saree, Lehenga Choli, Anarkali, Sherwani, Bandhgala, Tuxedo)",
  "visibleColors": ["Primary Color", "Secondary Color", "Accent Color"],
  "likelyFabric": "Likely fabric assessment and texture (e.g. Pure Silk, Chanderi, Georgette, Velvet, Organza)",
  "embroidery": "Embroidery, zari, sequins, threadwork, or embellishment details",
  "patterns": "Motifs, weave patterns, or surface prints",
  "neckline": "Neckline or collar cut and design",
  "sleeves": "Sleeve style and length",
  "otherDetails": "Other notable design elements (drape, border work, flare, tassels, silhouette)",
  "enhancementExplanation": "A thoughtful 2-3 sentence atelier explanation of how this outfit can be enhanced for a contemporary luxury aesthetic",
  "recommendations": [
    "Specific modification 1 with colors, fabrics, or silhouette tweaks",
    "Specific modification 2 with embellishment or styling enhancements",
    "Specific modification 3 with a modern fusion or dramatic styling twist"
  ]
}`;
	const base64Data = image.bytes.toString("base64");
	const dataUrl = `data:${image.type};base64,${base64Data}`;
	const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
	let response;
	try {
		response = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				model: visionModel,
				messages: [{
					role: "user",
					content: [{
						type: "text",
						text: prompt
					}, {
						type: "image_url",
						image_url: { url: dataUrl }
					}]
				}],
				response_format: { type: "json_object" }
			}),
			signal: AbortSignal.timeout(9e4)
		});
	} catch (netErr) {
		throw new HttpError(502, `Failed to connect to OpenAI: ${netErr.message || "Network request failed"}. Please check your connection.`);
	}
	const text = await response.text();
	let result;
	try {
		result = JSON.parse(text);
	} catch {
		throw new HttpError(502, "The AI provider returned an unreadable response.");
	}
	if (!response.ok) {
		const errorMsg = result?.error?.message || "Analysis failed.";
		if (response.status === 401) throw new HttpError(401, "OpenAI API key was rejected. Verify OPENAI_API_KEY in your .env file.");
		if (response.status === 429) throw new HttpError(429, `OpenAI quota error: ${errorMsg}. Please check billing at https://platform.openai.com/settings/organization/billing/ (or configure GEMINI_API_KEY in .env).`);
		throw new HttpError(response.status >= 500 ? 502 : response.status, `Image analysis error: ${errorMsg}`);
	}
	const content = result?.choices?.[0]?.message?.content;
	if (!content) throw new HttpError(502, "The AI provider returned an empty analysis.");
	try {
		return JSON.parse(content);
	} catch {
		throw new HttpError(502, "Failed to parse structured outfit analysis.");
	}
}
async function analyseOutfitWithGemini(image) {
	const apiKey = getGeminiKey();
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${getGeminiModel()}:generateContent?key=${apiKey}`;
	const base64Data = image.bytes.toString("base64");
	const userPrompt = `You are the master fashion designer and creative director at MYOO, a bespoke luxury Indian and global couture atelier.
Examine this uploaded outfit image in precise detail.
Identify its cut, fabrics, colors, embellishments, and structural details.
Explain how the outfit could be elevated or enhanced for a modern, high-fashion couture aesthetic.
Recommend three distinct, creative, and feasible modification ideas.

Respond strictly with a valid JSON object matching this schema:
{
  "outfitType": "Garment name and style category",
  "visibleColors": ["Color 1", "Color 2"],
  "likelyFabric": "Likely fabric and texture description",
  "embroidery": "Embroidery, zari, or embellishment details",
  "patterns": "Motifs, weave patterns, or surface prints",
  "neckline": "Neckline or collar cut",
  "sleeves": "Sleeve style and length",
  "otherDetails": "Other notable design elements",
  "enhancementExplanation": "2-3 sentences explaining how this outfit could be enhanced",
  "recommendations": ["Recommendation 1", "Recommendation 2", "Recommendation 3"]
}`;
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: userPrompt }, { inline_data: {
				mime_type: image.type,
				data: base64Data
			} }] }],
			generationConfig: { response_mime_type: "application/json" }
		}),
		signal: AbortSignal.timeout(9e4)
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new HttpError(response.status, `Gemini analysis error: ${data?.error?.message || response.statusText}`);
	const textContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!textContent) throw new HttpError(502, "Gemini returned empty response.");
	return JSON.parse(textContent);
}
async function generateRedesignWithOpenAI(image, instruction, outfitContext = "") {
	if (!process.env.OPENAI_API_KEY) throw new HttpError(503, "AI generation is not configured. Add OPENAI_API_KEY to your .env file.");
	const prompt = [
		"Redesign the garment in this outfit image according to the customer's design instruction:",
		`Customer instruction: "${instruction}".`,
		outfitContext ? `Original outfit context: ${outfitContext}.` : "",
		"Produce a photorealistic, high-end fashion catalog photograph showing the redesigned outfit clearly.",
		"Preserve garment realism, natural fabric drape, luxurious craft detailing, and clean professional editorial lighting.",
		"Do not add watermarks, text, or extra collages."
	].join(" ");
	const form = new FormData();
	form.append("model", MODEL);
	form.append("prompt", prompt);
	form.append("quality", "high");
	form.append("output_format", "png");
	form.append("image", new Blob([image.bytes], { type: image.type }), image.name);
	let upstream;
	try {
		upstream = await fetch("https://api.openai.com/v1/images/edits", {
			method: "POST",
			headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
			body: form,
			signal: AbortSignal.timeout(18e4)
		});
	} catch (netErr) {
		throw new HttpError(502, `Failed to connect to OpenAI: ${netErr.message || "Network request failed"}. Please check your connection.`);
	}
	const text = await upstream.text();
	let result;
	try {
		result = JSON.parse(text);
	} catch {
		throw new HttpError(502, "The image provider returned an unreadable response. Please try again.");
	}
	if (!upstream.ok) {
		const providerMessage = result?.error?.message;
		if (upstream.status === 401) throw new HttpError(401, "OpenAI API key was rejected. Verify OPENAI_API_KEY in your .env file.");
		if (upstream.status === 429) throw new HttpError(429, `OpenAI quota error: ${providerMessage || "Credit balance exhausted"}. Please add billing credits at https://platform.openai.com/settings/organization/billing/ (or configure GEMINI_API_KEY in .env).`);
		const message = typeof providerMessage === "string" ? providerMessage.slice(0, 400) : "Please try again later.";
		throw new HttpError(upstream.status === 429 ? 503 : 502, `Image generation failed: ${message}`);
	}
	const encodedImage = result?.data?.[0]?.b64_json;
	const imageUrl = result?.data?.[0]?.url;
	if (encodedImage) return `data:image/png;base64,${encodedImage}`;
	if (imageUrl) {
		const imgRes = await fetch(imageUrl);
		if (imgRes.ok) return `data:image/png;base64,${Buffer.from(await imgRes.arrayBuffer()).toString("base64")}`;
		return imageUrl;
	}
	throw new HttpError(502, "The image provider did not return a generated image.");
}
async function generateRedesignWithGemini(image, instruction, outfitContext = "") {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) throw new HttpError(503, "Gemini API key is not configured. Add GEMINI_API_KEY to your .env file.");
	const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
	const prompt = `A luxury fashion catalog photograph of a bespoke redesigned outfit: "${instruction}". ${outfitContext ? "Garment context: " + outfitContext : ""}. Professional couture editorial fashion photography, high resolution, photorealistic, intricate textures, clean neutral background.`;
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			instances: [{ prompt }],
			parameters: {
				sampleCount: 1,
				aspectRatio: "3:4"
			}
		}),
		signal: AbortSignal.timeout(18e4)
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new HttpError(response.status, `Gemini image generation error: ${data?.error?.message || response.statusText}`);
	const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
	if (!b64) throw new HttpError(502, "Gemini returned no image.");
	return `data:image/png;base64,${b64}`;
}
async function callGemini(payload, options = {}) {
	const apiKey = getGeminiKey();
	if (!apiKey) throw new HttpError(503, "Google Gemini API key is not configured.");
	const models = [
		getGeminiModel(),
		"gemini-3.5-flash-lite",
		"gemini-3.1-flash-lite",
		"gemini-3.5-flash",
		"gemini-3.8-flash",
		"gemini-3-flash-preview"
	].filter((m, i, arr) => m && arr.indexOf(m) === i);
	let lastError = null;
	for (const model of models) {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(options.timeout || 12e3)
			});
			const data = await response.json().catch(() => ({}));
			if (response.ok) {
				const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
				if (text) return {
					text,
					model
				};
			}
			const errMsg = data?.error?.message || response.statusText;
			lastError = new HttpError(response.status >= 500 ? 502 : response.status, `Gemini (${model}) error: ${errMsg}`);
			if (response.status === 404 || response.status === 503 || response.status === 429) continue;
			throw lastError;
		} catch (err) {
			if (err instanceof HttpError && err.status !== 502 && err.status !== 503 && err.status !== 429) throw err;
			lastError = err;
		}
	}
	throw lastError || new HttpError(502, "All Gemini AI models are currently busy. Please try again.");
}
async function scanClothWithGemini(image) {
	const base64Data = image.bytes.toString("base64");
	const { text } = await callGemini({
		contents: [{ parts: [{ text: `You are the master fashion stylist and textile expert at MYOO, a bespoke luxury Indian couture atelier ("From Karigar to Closet").
Carefully examine this cloth / garment image with high precision.
Identify and describe:
1. Visible colours (primary, secondary, and accent shades)
2. Likely fabrics (e.g. Pure Velvet, Raw Silk, Chanderi Silk, Organza, Georgette, Brocade)
3. Embroideries & handwork (e.g. Zardozi, Gota Patti, Resham threadwork, Sequins, Cutdana, Mirror work, or None if plain)
4. Garment type and silhouette (e.g. Lehenga Choli, Saree, Sherwani, Bandhgala, Anarkali, Kurta)
5. Surface motifs & patterns (e.g. Floral Jaal, Geometric chevron, Damask medallion)
6. A concise 2-sentence atelier styling critique.

Respond strictly with a valid JSON object matching this schema:
{
  "garmentType": "Garment name and style",
  "visibleColors": ["Primary color", "Secondary color", "Accent color"],
  "fabrics": "Fabric name and detailed assessment",
  "embroidery": "Embroideries and embellishment techniques observed",
  "patterns": "Visible patterns, motifs, or weave structure",
  "summary": "2-sentence styling critique and craft summary",
  "stylingSuggestions": [
    "Suggested jewelry / accessory pairing",
    "Suggested color / fabric pairing",
    "Recommended occasion"
  ]
}` }, { inline_data: {
			mime_type: image.type,
			data: base64Data
		} }] }],
		generationConfig: { response_mime_type: "application/json" }
	}, { timeout: 15e3 });
	const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
	try {
		return JSON.parse(cleaned);
	} catch {
		const match = cleaned.match(/\{[\s\S]*\}/);
		if (match) return JSON.parse(match[0]);
		throw new HttpError(502, "Could not parse cloth analysis JSON.");
	}
}
async function chatWithGeminiStylist(message, clothContext = "", history = []) {
	const systemPrompt = `You are MYOO's Senior Atelier Fashion Stylist & Custom Couturier.
MYOO is an Indian luxury custom clothing brand ("From Karigar to Closet").
You speak with warmth, elegance, and deep knowledge of Indian craft, bespoke tailoring, fabric choices (velvet, silk, chanderi, organza, georgette), embroideries (zardozi, resham, gota patti, sequins, cutdana), jewelry pairings, and silhouettes.
${clothContext ? `CURRENT SCANNED CLOTH CONTEXT:\n${clothContext}\nKeep this garment in mind when answering questions.` : ""}
Provide direct, concise, and inspiring fashion advice (2 to 4 sentences).`;
	const contents = [];
	if (Array.isArray(history)) {
		for (const item of history.slice(-6)) if (item.role && item.text) contents.push({
			role: item.role === "user" ? "user" : "model",
			parts: [{ text: item.text }]
		});
	}
	contents.push({
		role: "user",
		parts: [{ text: `${systemPrompt}\n\nCustomer message: ${message}` }]
	});
	const { text } = await callGemini({ contents }, { timeout: 12e3 });
	return text;
}
async function handleClothScan(request, response) {
	try {
		const contentType = request.headers["content-type"] || "";
		if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "Send the cloth image as multipart form data.");
		const body = await readBody(request);
		const clothFile = (await new Request("http://localhost/api/scan-cloth", {
			method: "POST",
			headers: { "content-type": contentType },
			body
		}).formData()).get("clothImage");
		if (!clothFile) throw new HttpError(400, "Please upload or drop a cloth image.");
		sendJson(response, 200, {
			success: true,
			scan: await scanClothWithGemini(await parseImage(clothFile, "Cloth image")),
			provider: "Google Gemini 3.8 Flash"
		});
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 502;
		const message = error instanceof HttpError ? error.message : error?.message || "Scan failed.";
		if (!response.headersSent) sendJson(response, status, { error: message });
	}
}
async function handleStylistChat(request, response) {
	try {
		const body = await readBody(request);
		let parsed;
		try {
			parsed = JSON.parse(body.toString("utf8"));
		} catch {
			throw new HttpError(400, "Invalid JSON body.");
		}
		const message = String(parsed.message || "").trim().slice(0, 1e3);
		if (!message) throw new HttpError(400, "Please enter a message for the stylist.");
		sendJson(response, 200, {
			success: true,
			reply: await chatWithGeminiStylist(message, String(parsed.clothContext || "").slice(0, 1e3), Array.isArray(parsed.history) ? parsed.history : []),
			provider: "Google Gemini 3.8 Flash"
		});
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 502;
		const message = error instanceof HttpError ? error.message : error?.message || "Chat failed.";
		if (!response.headersSent) sendJson(response, status, { error: message });
	}
}
async function handleOutfitAnalysis(request, response) {
	if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
		sendJson(response, 503, { error: "AI service is not configured. Please add OPENAI_API_KEY (or GEMINI_API_KEY) to your .env file." });
		return;
	}
	try {
		const contentType = request.headers["content-type"] || "";
		if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "Send the outfit image as multipart form data.");
		const body = await readBody(request);
		const outfitFile = (await new Request("http://localhost/api/analyse-outfit", {
			method: "POST",
			headers: { "content-type": contentType },
			body
		}).formData()).get("outfitImage");
		if (!outfitFile) throw new HttpError(400, "Please upload an outfit image to analyse.");
		const image = await parseImage(outfitFile, "Outfit image");
		let analysis;
		let provider = "";
		if (process.env.OPENAI_API_KEY) try {
			analysis = await analyseOutfitWithOpenAI(image);
			provider = "OpenAI";
		} catch (err) {
			analysis = await analyseOutfitWithGemini(image);
			provider = "Google Gemini 3.8 Flash";
		}
		else {
			analysis = await analyseOutfitWithGemini(image);
			provider = "Google Gemini 3.8 Flash";
		}
		sendJson(response, 200, {
			success: true,
			analysis,
			provider
		});
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 502;
		const message = error instanceof HttpError ? error.message : error?.message || "Analysis request failed.";
		if (!response.headersSent) sendJson(response, status, { error: message });
	}
}
async function handleOutfitRedesign(request, response) {
	if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
		sendJson(response, 503, { error: "AI service is not configured. Please add OPENAI_API_KEY (or GEMINI_API_KEY) to your .env file." });
		return;
	}
	if (!takeGenerationSlot(request.socket.remoteAddress || "unknown")) {
		sendJson(response, 429, { error: "Too many design generations from this connection. Please try again in a few minutes." });
		return;
	}
	try {
		const contentType = request.headers["content-type"] || "";
		if (!contentType.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "Send the outfit image and design instruction as multipart form data.");
		const body = await readBody(request);
		const form = await new Request("http://localhost/api/generate-design", {
			method: "POST",
			headers: { "content-type": contentType },
			body
		}).formData();
		const outfitFile = form.get("outfitImage");
		if (!outfitFile) throw new HttpError(400, "Please provide an outfit image.");
		const instruction = String(form.get("instruction") || "").trim().slice(0, 1e3);
		if (!instruction) throw new HttpError(400, "Please enter a design modification instruction.");
		const outfitContext = String(form.get("outfitContext") || "").trim().slice(0, 300);
		const image = await parseImage(outfitFile, "Outfit image");
		let generatedImage;
		let provider = "";
		if (process.env.OPENAI_API_KEY) try {
			generatedImage = await generateRedesignWithOpenAI(image, instruction, outfitContext);
			provider = "OpenAI";
		} catch (err) {
			if (process.env.GEMINI_API_KEY && (err.status === 429 || err.status === 401)) {
				generatedImage = await generateRedesignWithGemini(image, instruction, outfitContext);
				provider = "Gemini";
			} else throw err;
		}
		else if (process.env.GEMINI_API_KEY) {
			generatedImage = await generateRedesignWithGemini(image, instruction, outfitContext);
			provider = "Gemini";
		}
		sendJson(response, 200, {
			success: true,
			image: generatedImage,
			provider,
			model: MODEL
		});
	} catch (error) {
		const status = error instanceof HttpError ? error.status : 502;
		const message = error instanceof HttpError ? error.message : error?.message || "Design generation failed.";
		if (!response.headersSent) sendJson(response, status, { error: message });
	}
}
await loadLocalEnv();
PORT = Number(process.env.PORT || PORT);
MODEL = process.env.OPENAI_IMAGE_MODEL || MODEL;
async function handleRequest(request, response) {
	let pathname;
	try {
		const raw = request.headers["x-matched-path"] || request.headers["x-now-route-matches"] || request.url;
		pathname = new URL(raw, "http://localhost").pathname;
	} catch {
		sendJson(response, 400, { error: "Invalid request URL." });
		return;
	}
	if (request.method === "OPTIONS") {
		response.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization"
		});
		response.end();
		return;
	}
	if (pathname === "/api/health" && request.method === "GET") {
		sendJson(response, 200, {
			configured: true,
			provider: "Google Gemini 3.8 Flash (Google AI Studio)",
			model: getGeminiModel()
		});
		return;
	}
	if (pathname === "/api/scan-cloth" && request.method === "POST") {
		await handleClothScan(request, response);
		return;
	}
	if (pathname === "/api/chat-stylist" && request.method === "POST") {
		await handleStylistChat(request, response);
		return;
	}
	if (pathname === "/api/synthesize" && request.method === "POST") {
		await handleSynthesis(request, response);
		return;
	}
	if (pathname === "/api/analyse-outfit" && request.method === "POST") {
		await handleOutfitAnalysis(request, response);
		return;
	}
	if (pathname === "/api/generate-design" && request.method === "POST") {
		await handleOutfitRedesign(request, response);
		return;
	}
	await handleStatic(request, response, pathname);
}
const server = createServer(handleRequest);
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) server.listen(PORT, () => {
	console.log(`MYOO AI server listening at http://localhost:${PORT}`);
});
var server_default = handleRequest;

//#endregion
export { server_default as default, handleRequest };