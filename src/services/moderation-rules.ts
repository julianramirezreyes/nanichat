import { normalizeMatchText, matchesKeyword } from './automations.js';
import type { ProviderComment } from '../core/domain.js';

export type ModerationCategory = 'blocked_term' | 'spam_link' | 'spam_phone' | 'spam_mentions' | 'spam_emoji';

export type ModerationSettingsInput = {
  enabled: boolean;
  blockedTerms: string[];
  detectLinks: boolean;
  detectPhones: boolean;
  detectMentions: boolean;
  detectEmoji: boolean;
  autoHideEnabled: boolean;
  autoHideCategories: string[];
};

export type ModerationClassification = {
  flagged: boolean;
  category?: ModerationCategory;
  reasons: string[];
};

export function classifyForModeration(
  comment: ProviderComment,
  ownerUsername: string,
  settings: ModerationSettingsInput
): ModerationClassification {
  if (!settings.enabled) return { flagged: false, reasons: [] };
  
  if (comment.username && normalizeMatchText(comment.username) === normalizeMatchText(ownerUsername)) {
    return { flagged: false, reasons: [] };
  }

  const text = comment.text || '';
  if (!text) return { flagged: false, reasons: [] };

  const reasons: string[] = [];
  let highestCategory: ModerationCategory | undefined;

  // 1. blocked_term
  for (const term of settings.blockedTerms) {
    if (matchesKeyword(text, term, 'contains')) {
      reasons.push(`Contiene palabra prohibida: "${term}"`);
      if (!highestCategory) highestCategory = 'blocked_term';
    }
  }

  // 2. spam_link
  if (settings.detectLinks) {
    if (/https?:\/\/|www\.|bit\.ly|t\.me\/|wa\.me\//i.test(text)) {
      reasons.push('Contiene un enlace');
      if (!highestCategory) highestCategory = 'spam_link';
    }
  }

  // 3. spam_phone (7+ digit phone-like sequence, allowing spaces/dashes/+)
  if (settings.detectPhones) {
    const digitMatch = text.match(/(?:\+?[\d][\s-]*){7,}/);
    if (digitMatch) {
      reasons.push('Posible número de teléfono');
      if (!highestCategory) highestCategory = 'spam_phone';
    }
  }

  // 4. spam_mentions (3 or more distinct @handles)
  if (settings.detectMentions) {
    const mentions = Array.from(text.matchAll(/@([a-zA-Z0-9_.]+)/g)).map(m => m[1]!.toLowerCase());
    const distinct = new Set(mentions);
    if (distinct.size >= 3) {
      reasons.push(`Contiene demasiadas menciones (${distinct.size})`);
      if (!highestCategory) highestCategory = 'spam_mentions';
    }
  }

  // 5. spam_emoji
  if (settings.detectEmoji) {
    const emojis = Array.from(text.matchAll(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu)).map(m => m[0]!);
    let spamEmoji = false;
    
    // Check if same emoji repeated 6+ times
    const emojiCounts = new Map<string, number>();
    for (const emoji of emojis) {
      const count = (emojiCounts.get(emoji) || 0) + 1;
      emojiCounts.set(emoji, count);
      if (count >= 6) {
        spamEmoji = true;
        reasons.push(`Emoji repetido demasiadas veces (${emoji})`);
        break;
      }
    }

    if (!spamEmoji && emojis.length >= 10) {
      // Check if comment made only of emojis with 10+ emojis
      const textWithoutEmojisAndWhitespace = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]/gu, '');
      if (textWithoutEmojisAndWhitespace.length === 0) {
        spamEmoji = true;
        reasons.push(`Comentario compuesto solo de múltiples emojis (${emojis.length})`);
      }
    }

    if (spamEmoji && !highestCategory) {
      highestCategory = 'spam_emoji';
    }
  }

  if (highestCategory) {
    return { flagged: true, category: highestCategory, reasons };
  }

  return { flagged: false, reasons: [] };
}
