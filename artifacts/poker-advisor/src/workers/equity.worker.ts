import { calculateEquity, type EquityInput } from '@workspace/poker-engine';

self.onmessage = (event: MessageEvent<EquityInput>) => {
  try {
    self.postMessage({ result: calculateEquity(event.data) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Calculation failed' });
  }
};
