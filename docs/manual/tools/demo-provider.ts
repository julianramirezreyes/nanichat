/**
 * Fake social provider for the user-manual demo. 100% synthetic data, NO network I/O of any kind:
 * this module imports nothing that can open a socket and never calls fetch.
 *
 * It implements the same surface the app's MetaProvider exposes (SocialProvider plus
 * credentialForSelectedAccount) and returns canned Spanish content with short artificial delays so
 * the scan progress bar is visible in screenshots.
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AccountRef,
  ConnectionValidation,
  DiscoveredAccount,
  MediaItem,
  MediaType,
  MessageReadback,
  PrivateReplyPayload,
  ProviderComment,
  ProviderPage,
  PublicReplyResult,
  SendResult,
  SocialProvider,
} from '../../../src/core/domain.ts';

export const DEMO_ACCOUNTS: DiscoveredAccount[] = [
  { providerAccountId: '17841400000000001', username: 'tu_cuenta', displayName: 'Tu cuenta (demo)', accountType: 'BUSINESS', capabilities: ['identity_read', 'private_reply_unverified'] },
  { providerAccountId: '17841400000000002', username: 'tu_otra_cuenta', displayName: 'Tu otra cuenta (demo)', accountType: 'BUSINESS', capabilities: ['identity_read', 'private_reply_unverified'] },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PAGE_SIZE = 4;

type DemoMedia = { key: string; ageDays: number; type: MediaType; caption: string };
type DemoComment = { media: number; ageHours: number; user: string; text: string; reply?: number };

// Publications of @tu_cuenta, newest first. Index 3 (position 2) is the "course launch" post.
const MEDIA: DemoMedia[] = [
  { key: '01', ageDays: 2, type: 'VIDEO', caption: 'Comenta GUIA y te envío la guía gratis 🎁 Aprende a organizar tu semana en 10 minutos' },
  { key: '02', ageDays: 5, type: 'IMAGE', caption: '5 hábitos para trabajar con calma. Comenta GUIA y te la envío' },
  { key: '03', ageDays: 9, type: 'CAROUSEL_ALBUM', caption: 'Lanzamiento del curso: planificación para emprendedores. Comenta CURSO para recibir los detalles' },
  { key: '04', ageDays: 12, type: 'VIDEO', caption: 'Detrás de cámaras de nuestra sesión de fotos ✨' },
  { key: '05', ageDays: 16, type: 'IMAGE', caption: 'Plantilla gratuita de calendario de contenidos. Comenta GUIA' },
  { key: '06', ageDays: 20, type: 'CAROUSEL_ALBUM', caption: 'Checklist para lanzar tu primer producto digital' },
  { key: '07', ageDays: 24, type: 'IMAGE', caption: 'Gracias por 10 mil abrazos virtuales 💛' },
  { key: '08', ageDays: 29, type: 'VIDEO', caption: 'Tutorial rápido: tu primera automatización paso a paso. Comenta GUIA' },
];

const OTHER_MEDIA: DemoMedia[] = [
  { key: 'b1', ageDays: 3, type: 'IMAGE', caption: 'Nueva colección de primavera 🌸' },
  { key: 'b2', ageDays: 10, type: 'VIDEO', caption: 'Preguntas frecuentes sobre envíos' },
  { key: 'b3', ageDays: 18, type: 'CAROUSEL_ALBUM', caption: 'Guía de tallas' },
];

// 60 comments. `reply` is the index (in this array) of the parent comment. Ages in hours before "now".
const C = (media: number, ageHours: number, user: string, text: string, reply?: number): DemoComment => ({ media, ageHours, user, text, reply });
const COMMENTS: DemoComment[] = [
  // Publication 1 (indices 0-13)
  C(0, 3, 'maria_demo', 'GUIA'),
  C(0, 5, 'juan_demo', 'Quiero la guía por favor 🙏'),
  C(0, 8, 'ana_demo', 'Qué buen contenido, gracias por compartir'),
  C(0, 11, 'luis_demo', 'guia!!'),
  C(0, 14, 'sofia_demo', 'Me interesa la guía'),
  C(0, 20, 'carlos_demo', 'GUIA 🙌'),
  C(0, 22, 'laura_demo', 'Me encantó el video 😍'),
  C(0, 25, 'pedro_demo', 'Yo también la quiero', 0),
  C(0, 30, 'valentina_demo', 'guía porfa'),
  C(0, 33, 'diego_demo', '¿Es gratis de verdad?'),
  C(0, 40, 'camila_demo', 'Comento GUIA 😊'),
  C(0, 44, 'andres_demo', 'Genial!!'),
  C(0, 21, 'tu_cuenta', '¡Gracias Ana!', 2),
  C(0, 46, 'mateo_demo', 'Súper útil'),
  // Publication 2 (14-25)
  C(1, 30, 'paula_demo', 'Guía por favor'),
  C(1, 40, 'mateo_demo', 'GUIA'),
  C(1, 52, 'lucia_demo', 'Excelente consejo'),
  C(1, 60, 'tomas_demo', 'Me sirvió mucho, gracias'),
  C(1, 70, 'maria_demo', 'guia'),
  C(1, 80, 'juan_demo', 'El hábito 3 es el que más me cuesta'),
  C(1, 90, 'ana_demo', 'Quiero la guia'),
  C(1, 100, 'luis_demo', '¿Hay guía en PDF?'),
  C(1, 110, 'sofia_demo', 'Felicidades por el contenido'),
  C(1, 118, 'carlos_demo', 'GUIA'),
  C(1, 99, 'tu_cuenta', 'Sí, te la envío ahora mismo', 21),
  C(1, 95, 'laura_demo', 'Gracias por compartirlo', 18),
  // Publication 3: course launch (26-33)
  C(2, 12, 'pedro_demo', 'Curso'),
  C(2, 26, 'valentina_demo', '¿Cuándo empieza el curso?'),
  C(2, 50, 'diego_demo', 'Quiero el curso!'),
  C(2, 70, 'camila_demo', 'Felicidades por el lanzamiento 🎉'),
  C(2, 90, 'andres_demo', 'Me interesa el curso, ¿tiene certificado?'),
  C(2, 150, 'paula_demo', 'CURSO'),
  C(2, 200, 'mateo_demo', 'Curso por favor'),
  C(2, 30, 'lucia_demo', 'guia'),
  // Publication 4 (34-40)
  C(3, 100, 'tomas_demo', 'Me encanta el detrás de cámaras'),
  C(3, 140, 'maria_demo', 'GUIA'),
  C(3, 170, 'juan_demo', 'guia'),
  C(3, 220, 'ana_demo', 'Qué lindo set'),
  C(3, 250, 'luis_demo', 'guia por fa'),
  C(3, 280, 'sofia_demo', 'Fotos increíbles'),
  C(3, 120, 'carlos_demo', 'Quiero la guía'),
  // Publication 5 (41-46)
  C(4, 200, 'laura_demo', 'GUIA'),
  C(4, 230, 'pedro_demo', '¿Plantilla gratis? guia'),
  C(4, 260, 'valentina_demo', 'Me sirve muchísimo'),
  C(4, 300, 'diego_demo', 'Gracias!'),
  C(4, 330, 'camila_demo', 'Hermosa plantilla'),
  C(4, 360, 'andres_demo', 'GUIA'),
  // Publication 6 (47-51)
  C(5, 310, 'paula_demo', 'Muy completo'),
  C(5, 340, 'mateo_demo', 'Lo guardo para después'),
  C(5, 380, 'lucia_demo', 'Excelente lista'),
  C(5, 420, 'tomas_demo', 'GUIA'),
  C(5, 460, 'maria_demo', 'Gracias por tanto'),
  // Publication 7 (52-55)
  C(6, 400, 'juan_demo', 'Felicidades 🎉'),
  C(6, 450, 'ana_demo', 'Qué orgullo'),
  C(6, 500, 'luis_demo', 'Se lo merecen'),
  C(6, 520, 'sofia_demo', 'Abrazo grande'),
  // Publication 8 (56-59)
  C(7, 600, 'carlos_demo', 'Muy claro el paso a paso'),
  C(7, 640, 'laura_demo', 'GUIA'),
  C(7, 660, 'pedro_demo', 'Gracias por el tutorial'),
  C(7, 690, 'valentina_demo', 'Justo lo que buscaba'),
];

export type DemoFailureMode = 'retryable' | 'ambiguous';
export type DemoSentMessage = { text: string; buttons: Array<{ title: string; url: string }>; recipientId: string };

export type DemoProviderOptions = {
  /** Multiplier for the artificial delays; 0 disables them (used by the seed). */
  speed?: number;
  /** Looks up a message accepted earlier (from the local DB) so readMessage can confirm it. */
  resolveSent?: (messageId: string) => DemoSentMessage | undefined;
  /** Fixed "now" for deterministic timestamps; defaults to Date.now() at construction. */
  now?: number;
};

export class DemoProvider implements SocialProvider {
  private readonly baseNow: number;
  private readonly behaviors = new Map<string, DemoFailureMode>();
  private counter = 0;
  private pageCounter = 0;

  constructor(private readonly options: DemoProviderOptions = {}) {
    this.baseNow = options.now ?? Date.now();
  }

  /** Makes the next private reply to this comment fail in a canned way (used by the seed for varied queue states). */
  setBehavior(commentId: string, mode: DemoFailureMode): void {
    this.behaviors.set(commentId, mode);
  }

  /** Comment IDs in a stable order, useful for the seed to choose items. */
  static commentIds(accountIndex = 0): Array<{ commentId: string; user: string; text: string; media: number; ageHours: number; reply?: number }> {
    if (accountIndex !== 0) return [];
    return COMMENTS.map((comment, index) => ({ commentId: commentId(index), user: comment.user, text: comment.text, media: comment.media, ageHours: comment.ageHours, reply: comment.reply }));
  }

  static mediaId(index: number): string {
    return mediaId(MEDIA[index]!);
  }

  async validateConnection(_connectionId: string): Promise<ConnectionValidation> {
    await this.pause(350);
    return { status: 'valid', observedAt: new Date().toISOString(), providerUserId: DEMO_ACCOUNTS[0]!.providerAccountId, username: DEMO_ACCOUNTS[0]!.username, capabilities: ['identity_read'] };
  }

  async discoverAccounts(_connectionId: string): Promise<DiscoveredAccount[]> {
    await this.pause(500);
    return DEMO_ACCOUNTS.map((account) => ({ ...account, capabilities: [...account.capabilities] }));
  }

  async credentialForSelectedAccount(_connectionId: string, _account: DiscoveredAccount): Promise<string | undefined> {
    return undefined;
  }

  async listMedia(account: AccountRef, _cursor?: string): Promise<ProviderPage<MediaItem>> {
    await this.pause(300);
    const list = account.providerAccountId === DEMO_ACCOUNTS[0]!.providerAccountId ? MEDIA : OTHER_MEDIA;
    return {
      complete: true,
      items: list.map((item) => ({
        mediaId: mediaId(item),
        permalink: `https://ejemplo.com/demo/p/${item.key}`,
        publishedAt: new Date(this.baseNow - item.ageDays * DAY).toISOString(),
        caption: item.caption,
        mediaType: item.type,
      })),
    };
  }

  async listComments(account: AccountRef, mediaIdValue: string, cursor?: string): Promise<ProviderPage<ProviderComment>> {
    this.pageCounter++;
    await this.pause(350 + (this.pageCounter * 67) % 250);
    if (account.providerAccountId !== DEMO_ACCOUNTS[0]!.providerAccountId) return { items: [], complete: true };
    const mediaIndex = MEDIA.findIndex((item) => mediaId(item) === mediaIdValue);
    if (mediaIndex < 0) return { items: [], complete: true };
    const all = COMMENTS.map((comment, index) => ({ comment, index })).filter(({ comment }) => comment.media === mediaIndex);
    const offset = cursor ? Math.max(0, Number(cursor.replace(/^demo_cursor_/u, '')) || 0) : 0;
    const slice = all.slice(offset, offset + PAGE_SIZE);
    const next = offset + PAGE_SIZE;
    const hasMore = next < all.length;
    return {
      items: slice.map(({ comment, index }) => this.toProviderComment(comment, index)),
      complete: !hasMore,
      ...(hasMore ? { nextCursor: `demo_cursor_${next}` } : {}),
    };
  }

  async getComment(account: AccountRef, commentIdValue: string): Promise<ProviderComment> {
    await this.pause(120);
    const index = COMMENTS.findIndex((_comment, position) => commentId(position) === commentIdValue);
    if (index < 0 || account.providerAccountId !== DEMO_ACCOUNTS[0]!.providerAccountId) throw new Error('demo_comment_not_found');
    return this.toProviderComment(COMMENTS[index]!, index);
  }

  async sendPrivateReply(_account: AccountRef, commentIdValue: string, _payload: PrivateReplyPayload): Promise<SendResult> {
    await this.pause(400);
    const mode = this.behaviors.get(commentIdValue);
    if (mode === 'retryable') {
      return { outcome: 'definitive_rejection', safeErrorCode: 'meta_rate_limited', httpStatus: 429, usageHeaders: { retryAfter: '60' } };
    }
    if (mode === 'ambiguous') return { outcome: 'ambiguous', safeErrorCode: 'provider_timeout' };
    this.counter++;
    return { outcome: 'accepted', messageId: `demo_mid_${String(this.counter).padStart(4, '0')}_${commentIdValue.slice(-4)}`, httpStatus: 200 };
  }

  async replyToComment(_account: AccountRef, _commentId: string, _message: string): Promise<PublicReplyResult> {
    await this.pause(300);
    this.counter++;
    return { outcome: 'accepted', replyId: `demo_reply_${String(this.counter).padStart(4, '0')}`, httpStatus: 200 };
  }

  async readMessage(account: AccountRef, messageId: string): Promise<MessageReadback> {
    await this.pause(200);
    const sent = this.options.resolveSent?.(messageId);
    if (!sent) throw new Error('demo_message_not_found');
    return {
      messageId,
      senderId: account.providerAccountId,
      recipientId: sent.recipientId,
      text: sent.text,
      createdAt: new Date().toISOString(),
      attachments: [],
      ...(sent.buttons.length ? { templates: [{ title: sent.text, buttons: sent.buttons.map((button) => ({ ...button, type: 'web_url' })) }] } : {}),
      observedAt: new Date().toISOString(),
    };
  }

  private toProviderComment(comment: DemoComment, index: number): ProviderComment {
    return {
      commentId: commentId(index),
      text: comment.text,
      username: comment.user,
      createdAt: new Date(this.baseNow - comment.ageHours * HOUR).toISOString(),
      ...(comment.reply !== undefined ? { parentId: commentId(comment.reply) } : {}),
    };
  }

  private async pause(ms: number): Promise<void> {
    const scaled = ms * (this.options.speed ?? 1);
    if (scaled > 0) await new Promise((resolve) => setTimeout(resolve, scaled));
  }
}

function mediaId(item: DemoMedia): string {
  return `1790000000${item.key.padStart(6, '0')}`;
}

function commentId(index: number): string {
  return `1800000000${String(index + 1).padStart(6, '0')}`;
}

/** Demo safety guard: the data directory must live under /tmp (never the real ./data). Returns the resolved path. */
export function assertDemoDataDir(raw: string | undefined): string {
  if (!raw) throw new Error('LOCAL_SOCIAL_DATA_DIR is required for the demo and must point under /tmp');
  const directory = resolve(raw);
  const real = existsSync(directory) ? realpathSync(directory) : directory;
  if (!directory.startsWith('/tmp/') || !real.startsWith('/tmp/')) {
    throw new Error('Refusing to start: LOCAL_SOCIAL_DATA_DIR must be a directory under /tmp');
  }
  return directory;
}

/** Legacy interlock stand-in that is never blocked and touches no filesystem (no "retención heredada" state). */
export function createNeverBlockedInterlock() {
  const state = { blocked: false, lockPresent: false, counterVersion: 'absent' } as const;
  return {
    inspect: (_username: string) => ({ ...state }),
    acknowledge: (_username: string, _expected: string) => ({ ok: true, state: { ...state } }),
    withExclusiveLock: async <T>(_username: string, operation: () => Promise<T>): Promise<T> => operation(),
  };
}
