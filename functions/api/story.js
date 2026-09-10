// Cloudflare Pages Function: POST /api/story
//
// This runs on Cloudflare's servers, never in the visitor's browser. It
// supports two AI providers:
//   - Gemini (Google) — site default, key comes from env.GEMINI_API_KEY
//     unless the player supplies their own. Also handles Gemma models
//     (e.g. gemma-4-31b-it), which are served through the same endpoint.
//   - Groq — free-tier, OpenAI-compatible chat API. No site default key is
//     required; players supply their own Groq key via the app's API key
//     button (or set env.GROQ_API_KEY to give the whole site a default).
//
// Either way it returns a response in the same { content: [{ type, text }] }
// shape the frontend already knows how to read.

const DEFAULT_MODELS = {
  gemini: "gemini-3.1-flash-lite",
  groq: "openai/gpt-oss-120b",
};

// Output token budget per model. The response now includes a short running
// "summary" field alongside the narration, so this is a bit higher than
// narration alone would need — kept modest for llama-3.1-8b-instant
// specifically since its free tier has a very small total (input + output)
// tokens-per-minute limit. Gemma 4 gets a much larger budget because its
// "thinking" tokens are drawn from the same maxOutputTokens pool, so a low
// budget can leave no room for the actual JSON answer and truncate it.
const OUTPUT_TOKEN_BUDGETS = {
  "llama-3.1-8b-instant": 1200,
  "gemma-4-31b-it": 4000,
  "gemma-4-26b-a4b-it": 4000,
};
const DEFAULT_OUTPUT_TOKENS = 2000;

function outputBudgetFor(model) {
  return OUTPUT_TOKEN_BUDGETS[model] || DEFAULT_OUTPUT_TOKENS;
}

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

  const provider = body.provider === "groq" ? "groq" : "gemini";
  const model = (typeof body.model === "string" && body.model.trim()) || DEFAULT_MODELS[provider];
  const userKey = typeof body.apiKey === "string" && body.apiKey.trim();

  if (provider === "groq") {
    return handleGroq({ messages, model, apiKey: userKey || env.GROQ_API_KEY });
  }
  return handleGemini({ messages, model, apiKey: userKey || env.GEMINI_API_KEY });
}

async function handleGemini({ messages, model, apiKey }) {
  if (!apiKey) {
    return jsonResponse(
      {
        error: {
          message:
            "Server is missing GEMINI_API_KEY. Add it in Cloudflare Pages > Settings > Environment variables, or paste your own key via the app's API key button.",
        },
      },
      500
    );
  }

  // Gemini has no separate "system" role in this simple form, and uses
  // "model" instead of "assistant" for the AI's own turns. The first message
  // here is Story Loom's big instruction/system prompt sent as a normal
  // "user" turn, which Gemini (and Gemma) handles fine as the first turn.
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }],
  }));

  const generationConfig = { maxOutputTokens: outputBudgetFor(model) };
  // Gemma 4 models think out loud in <thought>...</thought> tags before
  // their actual answer, consuming part of maxOutputTokens. There's no way
  // to fully disable this (thinkingLevel only accepts "MINIMAL" or "HIGH" —
  // there is no "off"), so we ask for minimal thinking and give Gemma a
  // larger token budget above, then strip any <thought> block from the
  // response text below before returning it.
  if (/^gemma-/.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: "MINIMAL" };
  }

  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents, generationConfig }),
      }
    );
  } catch (networkErr) {
    return jsonResponse({ error: { message: `Couldn't reach Gemini: ${networkErr.message}` } }, 502);
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || `Gemini request failed (status ${res.status}).`;
    return jsonResponse({ error: { message: msg } }, res.status);
  }
  if (!data) {
    return jsonResponse({ error: { message: "Gemini sent back something unreadable." } }, 502);
  }

  const candidate = data.candidates?.[0];
  if (!candidate) {
    // Often means the prompt or the response got blocked by Gemini's safety filters.
    const blockReason = data.promptFeedback?.blockReason;
    return jsonResponse(
      { error: { message: blockReason ? `Gemini blocked this request (${blockReason}).` : "Gemini returned no candidates." } },
      502
    );
  }

  let text = (candidate.content?.parts || []).map((p) => p.text || "").join("");
  // Defensive: strip any leaked <thought>...</thought> block (Gemma 4)
  // before it reaches the frontend's JSON parser.
  text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim();

  const finishReason = candidate.finishReason;

  if (!text) {
    return jsonResponse(
      { error: { message: finishReason ? `Gemini returned no text (finish reason: ${finishReason}).` : "Gemini returned empty text." } },
      502
    );
  }

  if (finishReason === "MAX_TOKENS") {
    return jsonResponse(
      {
        error: {
          message: `Gemini's response was cut off before finishing (ran out of the ${outputBudgetFor(
            model
          )}-token budget, likely spent on reasoning). Try again, or raise OUTPUT_TOKEN_BUDGETS for this model.`,
        },
      },
      502
    );
  }

  return jsonResponse({ content: [{ type: "text", text }] }, 200);
}

async function handleGroq({ messages, model, apiKey }) {
  if (!apiKey) {
    return jsonResponse(
      {
        error: {
          message:
            "No Groq API key set. Paste your own free Groq key via the app's API key button (console.groq.com/keys), or ask the site owner to add GROQ_API_KEY in Cloudflare Pages settings.",
        },
      },
      500
    );
  }

  // Groq's chat completions endpoint is OpenAI-compatible, and already uses
  // "user"/"assistant" roles — the same shape this app already sends — so
  // no role translation is needed here, unlike Gemini.
  const chatMessages = messages.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content ?? ""),
  }));

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: chatMessages, max_tokens: outputBudgetFor(model) }),
    });
  } catch (networkErr) {
    return jsonResponse({ error: { message: `Couldn't reach Groq: ${networkErr.message}` } }, 502);
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = data?.error?.message || `Groq request failed (status ${res.status}).`;
    return jsonResponse({ error: { message: msg } }, res.status);
  }
  if (!data) {
    return jsonResponse({ error: { message: "Groq sent back something unreadable." } }, 502);
  }

  const text = data.choices?.[0]?.message?.content || "";
  if (!text) {
    const finishReason = data.choices?.[0]?.finish_reason;
    return jsonResponse(
      { error: { message: finishReason ? `Groq returned no text (finish reason: ${finishReason}).` : "Groq returned empty text." } },
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
