import { Router, type IRouter } from "express";
import OpenAI from "openai";
import { ScanCardsBody } from "@workspace/api-zod";

const router: IRouter = Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

router.post("/scan-cards", async (req, res): Promise<void> => {
  const parsed = ScanCardsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { imageBase64 } = parsed.data;

  const prompt = `You are analyzing a poker game screenshot. Extract the following information:

1. The player's OWN hole cards (the 2 face-up cards belonging to the user, usually at the bottom of the screen). These are the cards the player is holding.
2. Community/board cards (face-up cards in the center of the table - flop, turn, river).
3. Pot size (the total chips/coins in the pot, if visible as a number).
4. Bet to call (amount the player needs to call, if there is a pending bet/raise shown).
5. Number of players at the table (count the player seats visible).

Card format rules:
- Ranks: A, K, Q, J, T (for 10), 9, 8, 7, 6, 5, 4, 3, 2
- Suits: h (hearts ♥), d (diamonds ♦), c (clubs ♣), s (spades ♠)
- Example cards: "Ah" = Ace of Hearts, "Ks" = King of Spades, "Td" = Ten of Diamonds

IMPORTANT: 
- Only include cards that are clearly visible and face-up. Do NOT guess face-down cards.
- If the player's own cards are face-down or not visible, return empty holeCards array.
- If no community cards are shown yet (pre-flop), return empty communityCards array.
- For TON Poker specifically: the player's cards are usually shown at the bottom of the screen.

Respond ONLY with valid JSON in this exact format:
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

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "high",
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

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      req.log.warn({ content }, "No JSON in OpenAI response");
      res.status(500).json({ error: "Could not parse AI response" });
      return;
    }

    const result = JSON.parse(jsonMatch[0]);

    res.json({
      holeCards: result.holeCards ?? [],
      communityCards: result.communityCards ?? [],
      potSize: result.potSize ?? null,
      betToCall: result.betToCall ?? null,
      players: result.players ?? null,
      confidence: result.confidence ?? 0,
      rawDescription: result.rawDescription ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "OpenAI Vision error");
    res.status(500).json({ error: "AI analysis failed" });
  }
});

export default router;
