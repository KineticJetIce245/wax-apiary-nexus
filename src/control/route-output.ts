export function queryParam(rawUrl: string | undefined, name: string): string | undefined {
  if (rawUrl === undefined) {
    return undefined;
  }
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex === -1) {
    return undefined;
  }
  const value = new URLSearchParams(rawUrl.slice(queryIndex + 1)).get(name);
  return value === null || value === '' ? undefined : value;
}
