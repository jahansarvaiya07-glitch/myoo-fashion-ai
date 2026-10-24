# MYOO Fashion AI Atelier

MYOO is a luxury custom outfit website ("From Karigar to Closet"). It combines foundational silhouette collections, custom fabric pricing, and AI-powered fashion design capabilities.

## Features

### 1. MYOO AI Fashion Designer
Upload any reference outfit photo to:
1. **Analyse My Outfit**: The AI inspects the garment and identifies:
   - Outfit type (e.g., Lehenga, Saree, Sherwani, Tuxedo)
   - Visible colors
   - Likely fabrics (e.g., Raw Silk, Chanderi, Georgette, Velvet, Organza)
   - Embroidery & handwork (e.g., Zardozi, Gota Patti, Resham)
   - Patterns & motifs (e.g., Floral Jaal, Geometric)
   - Neckline / collar & sleeve styling
   - Other notable design details
2. **Atelier Critique & Recommendations**: Explains how the outfit can be enhanced for a contemporary luxury aesthetic and provides 3 clickable recommendation chips.
3. **Custom Modification**: Type custom instructions (e.g., *"Change the colour to wine red with antique zardozi embroidery"* or click any recommendation).
4. **Generate My Design**: Produces a bespoke AI-generated redesigned outfit image with side-by-side original/redesign comparison.

### 2. Collection & Customizer
Browse luxury handcrafted silhouettes with fabric multipliers, reference styling fees, and live estimate breakdown.

## Run Locally

1. Install **Node.js 20** or later.
2. In this folder, ensure `.env` is configured:
   ```env
   # Primary AI Provider: OpenAI (supports Vision Analysis & Image Edits)
   OPENAI_API_KEY=your_openai_api_key_here
   OPENAI_IMAGE_MODEL=gpt-image-1
   OPENAI_VISION_MODEL=gpt-4o-mini

   # Optional Alternative Provider: Google Gemini
   # GEMINI_API_KEY=your_gemini_api_key_here

   PORT=4173
   ```
3. Run:
   ```bash
   npm start
   ```
4. Open [http://localhost:4173](http://localhost:4173) in your browser.

## Security & Architecture

- **Backend-Only Keys**: API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`) stay securely on the Node.js server and are never exposed in frontend code.
- **Zero Heavy Dependencies**: Built using native Node.js HTTP and web standards (`fetch`, `FormData`, `Blob`).
- **No Extra Database Required**: The upload, analysis, modification, and generation work end-to-end statelessly.
- **Billing / Quota Guidance**: If API credits are exhausted or keys are unconfigured, clear status and hints are surfaced to the user directly in the interface.
