export class LiveHiveServiceError extends Error {
  constructor(
    readonly kind: 'invalid' | 'not-found' | 'project' | 'conflict' | 'unsupported',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LiveHiveServiceError';
  }
}

export class LiveHiveNotFoundError extends LiveHiveServiceError {
  constructor(readonly liveId: string) {
    super('not-found', `live hive is not loaded: ${liveId}`);
    this.name = 'LiveHiveNotFoundError';
  }
}
