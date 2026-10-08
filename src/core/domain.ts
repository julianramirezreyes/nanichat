export type ProviderCode = 'META';
export type MetaLoginKind = 'instagram_login' | 'facebook_login';
export type ConnectionStatus = 'unvalidated' | 'valid' | 'invalid' | 'disconnected';
export type AccountStatus = 'unvalidated' | 'valid' | 'invalid' | 'disconnected';

export type AccountRef = {
  accountId: string;
  connectionId: string;
  providerAccountId: string;
  username: string;
};

export type ConnectionValidation = {
  status: ConnectionStatus;
  observedAt: string;
  providerUserId?: string;
  username?: string;
  capabilities: string[];
  safeErrorCode?: string;
};

export type DiscoveredAccount = {
  providerAccountId: string;
  username: string;
  displayName?: string;
  accountType?: string;
  relatedPageId?: string;
  capabilities: string[];
};

export type MediaType = 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';

export type MediaItem = {
  mediaId: string;
  permalink?: string;
  publishedAt?: string;
  /** Display-only, already truncated by the provider. */
  caption?: string;
  mediaType?: MediaType;
};

export type ProviderComment = {
  commentId: string;
  text?: string;
  username?: string;
  createdAt?: string;
  parentId?: string;
};

export type ProviderPage<T> = {
  items: T[];
  nextCursor?: string;
  complete: boolean;
  stopReason?: string;
};

export type PrivateReplyPayload = {
  text: string;
  buttons: Array<{ title: string; url: string }>;
};

export type SendResult = {
  outcome: 'accepted' | 'definitive_rejection' | 'ambiguous';
  messageId?: string;
  safeErrorCode?: string;
  httpStatus?: number;
  metaCode?: number;
  metaSubcode?: number;
  usageHeaders?: { appUsage?: string; pageUsage?: string; retryAfter?: string };
};

/** Outcome of a public reply to a comment (`POST /{comment-id}/replies`). Same outcome semantics as SendResult. */
export type PublicReplyResult = {
  outcome: 'accepted' | 'definitive_rejection' | 'ambiguous';
  replyId?: string;
  safeErrorCode?: string;
  httpStatus?: number;
  metaCode?: number;
  usageHeaders?: { appUsage?: string; pageUsage?: string; retryAfter?: string };
};

export type MessageReadback = {
  messageId: string;
  senderId?: string;
  recipientId?: string;
  text?: string;
  createdAt?: string;
  attachments?: Array<{ type?: string; payload?: Record<string, unknown> }>;
  /** Normalized generic templates (title and cta buttons) as observed in the readback, bounded in size. */
  templates?: Array<{ title?: string; buttons: Array<{ title: string; url: string; type?: string }> }>;
  observedAt: string;
};

export interface SocialProvider {
  validateConnection(connectionId: string): Promise<ConnectionValidation>;
  discoverAccounts(connectionId: string): Promise<DiscoveredAccount[]>;
  listMedia(account: AccountRef, cursor?: string): Promise<ProviderPage<MediaItem>>;
  listComments(account: AccountRef, mediaId: string, cursor?: string): Promise<ProviderPage<ProviderComment>>;
  getComment(account: AccountRef, commentId: string): Promise<ProviderComment>;
  sendPrivateReply(account: AccountRef, commentId: string, payload: PrivateReplyPayload): Promise<SendResult>;
  readMessage(account: AccountRef, messageId: string): Promise<MessageReadback>;
  replyToComment(account: AccountRef, commentId: string, message: string): Promise<PublicReplyResult>;
}

export type QueueState =
  | 'DISCOVERED'
  | 'MATCHED'
  | 'QUEUED'
  | 'SEND_INTENT_RECORDED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED_RETRYABLE'
  | 'FAILED_PERMANENT'
  | 'UNKNOWN_OUTCOME'
  | 'EXPIRED'
  | 'SKIPPED'
  | 'SIMULATED';

export type EncryptedSecret = {
  nonce: string;
  ciphertext: string;
  tag: string;
};
