import { randomInt } from "node:crypto";

/**
 * Server-side word bank. Clients never see this list. Words are picked
 * with crypto.randomInt so the sequence can't be predicted from past words.
 */
export const WORD_BANK: readonly string[] = [
  // animals
  "cat", "dog", "elephant", "giraffe", "penguin", "kangaroo", "octopus", "butterfly", "snail", "shark",
  "turtle", "rabbit", "monkey", "lion", "zebra", "camel", "owl", "frog", "spider", "dolphin",
  "peacock", "crocodile", "jellyfish", "hedgehog", "flamingo",
  // food
  "apple", "banana", "pizza", "burger", "ice cream", "sandwich", "carrot", "watermelon", "cupcake", "popcorn",
  "pineapple", "donut", "noodles", "cheese", "egg", "mango", "taco", "cookie", "samosa", "biryani",
  // objects
  "umbrella", "scissors", "ladder", "guitar", "camera", "clock", "candle", "glasses", "backpack", "key",
  "lamp", "pencil", "toothbrush", "headphones", "telescope", "anchor", "balloon", "bicycle", "hammer", "mirror",
  "kite", "crown", "trophy", "magnet", "envelope",
  // places & nature
  "castle", "volcano", "island", "rainbow", "waterfall", "desert", "lighthouse", "bridge", "mountain", "cave",
  "snowman", "tornado", "moon", "sun", "cloud", "tree", "flower", "cactus", "river", "beach",
  // vehicles
  "rocket", "helicopter", "submarine", "train", "tractor", "airplane", "sailboat", "ambulance", "skateboard", "bus",
  // actions & concepts
  "sleeping", "dancing", "swimming", "fishing", "juggling", "reading", "cooking", "running", "singing", "painting",
  // misc
  "robot", "ghost", "dragon", "pirate", "wizard", "mermaid", "alien", "unicorn", "vampire", "ninja",
  "fireworks", "birthday cake", "treasure chest", "spider web", "traffic light", "hot air balloon", "roller coaster",
  "light bulb", "paper plane", "sand castle",
];

/** Picks a random word not yet used in this game; recycles the bank if exhausted. */
export function pickWord(usedWords: Set<string>, bank: readonly string[] = WORD_BANK): string {
  let candidates = bank.filter((word) => !usedWords.has(word));
  if (candidates.length === 0) {
    usedWords.clear();
    candidates = [...bank];
  }
  const word = candidates[randomInt(candidates.length)];
  if (word === undefined) throw new Error("Word bank is empty");
  usedWords.add(word);
  return word;
}
