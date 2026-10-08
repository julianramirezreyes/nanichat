export class RepositoryConflictError extends Error {
  constructor(message = 'The account is already actively managed by another connection') {
    super(message);
    this.name = 'RepositoryConflictError';
  }
}

export class VaultKeyMissingError extends Error {
  constructor() {
    super('Vault key is missing while encrypted credentials exist; restore the key before continuing');
    this.name = 'VaultKeyMissingError';
  }
}

export class VaultKeyInvalidError extends Error {
  constructor() {
    super('Vault key is invalid; refusing to replace or discard encrypted credentials');
    this.name = 'VaultKeyInvalidError';
  }
}

export class InvalidConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConfigurationError';
  }
}
