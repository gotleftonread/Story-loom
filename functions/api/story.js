// Cloudflare Pages Function: POST /api/story
//
// This runs on Cloudflare's servers, never in the visitor's browser, so the
// GEMINI_API_KEY below (set as an environment variable in your Cloudflare
// Pages project settings — NOT written in this file) is never exposed to
// anyone who visits the site.
//
// It accepts the same { messages: [...] } shape the frontend already sends
// (Anthropic-style role/content pairs), converts it to the shape Gemini's
// API expects, and returns a response in the same { content: [{ type,
// text }] } shape the frontend already knows how to read — so the frontend
// code barely had to change at all.

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { message: "Invalid JSON in request body." } }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    return jsonResponse({ error: { message: "No messages provided." } }, 400);
  }

  const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim()) || env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: { message: "Server is missing GEMINI_API_KEY. Add it in Cloudflare Pages > Settings > Environment variables, or paste your own key via the app's API key button." } },
      500
    );
  }

  // Gemini has no separate "system" role in this simple form, and uses
  // "model" instead of "assistant" for the AI's own turns. The first
  // message here is Story Loom's big instruction/system prompt sent as a
  // normal "user" turn, which Gemini handles fine as the first turn.
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }],
  }));

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: { maxOutputTokens: 1500 },
        }),
      }
    );
  } catch (networkErr) {
    return jsonResponse({ error: { message: `Couldn't reach Gemini: ${networkErr.message}` } }, 502);
  }

  const data = await geminiRes.json().catch(() => null);

  if (!geminiRes.ok) {
    const msg = data?.error?.message || `Gemini request failed (status ${geminiRes.status}).`;
    return jsonResponse({ error: { message: msg } }, geminiRes.status);
  }
  if (!data) {
    return jsonResponse({ error: { message: "Gemini sent back something unreadable." } }, 502);
  }

  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (!candidate) {
    // Often means the prompt or the response got blocked by Gemini's safety
    // filters rather than a hard error.
    const blockReason = data.promptFeedback?.blockReason;
    return jsonResponse(
      { error: { message: blockReason ? `Gemini blocked this request (${blockReason}).` : "Gemini returned no candidates." } },
      502
    );
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) {
    return jsonResponse(
      { error: { message: finishReason ? `Gemini returned no text (finish reason: ${finishReason}).` : "Gemini returned empty text." } },
      502
    );
  }

  return jsonResponse({ content: [{ type: "text", text }] }, 200);
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
