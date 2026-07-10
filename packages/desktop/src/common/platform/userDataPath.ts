import path from 'path';

export function readExplicitUserDataDir(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--user-data-dir=')) {
      const value = arg.slice('--user-data-dir='.length).trim();
      return value || undefined;
    }
    if (arg === '--user-data-dir') {
      const value = argv[index + 1]?.trim();
      return value && !value.startsWith('--') ? value : undefined;
    }
  }
  return undefined;
}

export function shouldUseGlobalCliSafeSymlink(argv: readonly string[] = process.argv): boolean {
  return readExplicitUserDataDir(argv) === undefined;
}

export function resolveElectronUserDataPath(
  currentUserDataPath: string,
  appName: string,
  argv: readonly string[] = process.argv
): string {
  const explicitUserDataDir = readExplicitUserDataDir(argv);
  if (explicitUserDataDir) return path.resolve(explicitUserDataDir);
  return path.join(path.dirname(currentUserDataPath), appName);
}
