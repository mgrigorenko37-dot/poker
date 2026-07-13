import { Router, type IRouter } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ScanCardsBody } from "@workspace/api-zod";

const router: IRouter = Router();

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable is required");
}

const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const prompt = `You are analyzing a poker game screenshot. Extract the following information:

1. The player's OWN hole cards (the 2 face-up cards belonging to the user, usually at the bottom of the screen).
2. Community/board cards (face-up cards in the center of the table - flop, turn, river).
3. Pot size (total chips/coins in the pot, if visible as a number).
4. Bet to call (amount the player needs to call, if a pending bet/raise is shown).
5. Number of players at the table (count visible player seats).

Card format rules:
- Ranks: A, K, Q, J, T (for 10), 9, 8, 7, 6, 5, 4, 3, 2
- Suits: h (hearts ♥), d (diamonds ♦), c (clubs ♣), s (spades ♠)
- Examples: "Ah" = Ace of Hearts, "Ks" = King of Spades, "Td" = Ten of Diamonds

IMPORTANT:
- Only include cards that are clearly visible and face-up. Do NOT guess face-down cards.
- If the player's own cards are face-down or not visible, return empty holeCards array.
- If no community cards are shown yet (pre-flop), return empty communityCards array.
- For TON Poker: the player's own cards are shown at the bottom of the table.

Respond ONLY with valid JSON in this exact format (no markdown, no code blocks):
{
  "holeCards": ["Ah", "Ks"],
  "communityCards": ["2d", "7c", "Qh"],
  "potSize": 1.50,
  "betToCall": 0.10,
  "players": 6,
  "confidence": 0.9,
  "rawDescription": "Brief description of what you see"
}

If you cannot detect cards clearly, return confidence 0 and empty arrays.`;

router.post("/scan-cards", async (req, res): Promise<void> => {
  const parsed = ScanCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { imageBase64 } = parsed.data;

  try {
    const model = genai.getGenerativeModel({ model: "gemini-2.0-flash" });

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: imageBase64,
        },
      },
      prompt,
    ]);

    const content = result.response.text();
    req.log.debug({ content }, "Gemini raw response");

    // Strip markdown code blocks if present
    const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      req.log.warn({ content }, "No JSON in Gemini response");
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
    req.log.error({ err }, "Gemini Vision error");
    if (err?.status === 429) {
      res.status(429).json({ error: "Gemini quota exceeded — wait a minute and try again, or increase scan interval" });
    } else {
      res.status(500).json({ error: "AI analysis failed" });
    }
  }
});

export default router;
