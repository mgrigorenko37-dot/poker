import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { ScanCardsBody } from "@workspace/api-zod";

const router: IRouter = Router();

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY environment variable is required");
}

// OpenRouter uses OpenAI-compatible API — free vision models, no quotas
const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://pokerterminal.app",
    "X-Title": "Poker Terminal",
  },
});

const prompt = `You are analyzing a poker game screenshot (TON Poker Telegram Mini App).

Extract:
1. Player's OWN hole cards — 2 face-up cards at the BOTTOM of the screen belonging to the user.
2. Community/board cards — face-up cards in the CENTER of the table (flop/turn/river).
3. Pot size — total chips visible in the pot area.
4. Bet to call — amount shown that player must call (if any pending bet).
5. Number of players — count of player seats visible at the table.

Card format:
- Rank: A K Q J T 9 8 7 6 5 4 3 2
- Suit: h=hearts d=diamonds c=clubs s=spades
- Example: "Ah"=Ace of Hearts "Ks"=King of Spades "Td"=Ten of Diamonds

Rules:
- Only include CLEARLY VISIBLE face-up cards. Never guess face-down cards.
- If hole cards are face-down, return empty holeCards array.
- If no board cards yet (pre-flop), return empty communityCards array.

Respond ONLY with raw JSON (no markdown, no code blocks):
{"holeCards":["Ah","Ks"],"communityCards":["2d","7c","Qh"],"potSize":1.50,"betToCall":0.10,"players":6,"confidence":0.9,"rawDescription":"what you see"}

If cards not visible: {"holeCards":[],"communityCards":[],"potSize":null,"betToCall":null,"players":null,"confidence":0,"rawDescription":"cards not visible"}`;

router.post("/scan-cards", async (req, res): Promise<void> => {
  const parsed = ScanCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { imageBase64 } = parsed.data;

  try {
    const response = await openai.chat.completions.create({
      // Free vision model on OpenRouter — no quotas
      model: "google/gemma-4-31b-it:free",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const content = response.choices[0]?.message?.content ?? "";
    req.log.debug({ content }, "OpenRouter raw response");

    // Strip markdown if present
    const cleaned = content
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      req.log.warn({ content }, "No JSON in OpenRouter response");
      res.status(500).json({ error: "Could not parse AI response" });
      return;
    }

    const data = JSON.parse(jsonMatch[0]);

    res.json({
      holeCards: Array.isArray(data.holeCards) ? data.holeCards : [],
      communityCards: Array.isArray(data.communityCards) ? data.communityCards : [],
      potSize: data.potSize ?? null,
      betToCall: data.betToCall ?? null,
      players: data.players ?? null,
      confidence: typeof data.confidence === "number" ? data.confidence : 0,
      rawDescription: data.rawDescription ?? null,
    });
  } catch (err: any) {
    req.log.error({ err }, "OpenRouter Vision error");
    if (err?.status === 429) {
      res.status(429).json({ error: "Rate limit — wait a moment and try again" });
    } else {
      res.status(500).json({ error: "AI analysis failed" });
    }
  }
});

export default router;
