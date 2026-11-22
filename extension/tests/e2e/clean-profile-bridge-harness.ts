import path from 'node:path';

export interface CleanProfileLaunchOptions {
  extensionPath: string;
  profilePath: string;
  isolated: true;
}

export interface CleanProfileSession {
  close(): Promise<void>;
}

/** Adapter seam for a future real-browser test. This module does not launch Chrome. */
export interface CleanProfileBridgeAdapter {
  launch(options: CleanProfileLaunchOptions): Promise<CleanProfileSession>;
}

/** Runs a caller-supplied scenario only with an isolated profile and dist/extension. */
export async function withCleanProfileBridge<T>(options: {
  adapter: CleanProfileBridgeAdapter;
  repositoryRoot: string;
  profilePath: string;
  scenario(session: CleanProfileSession): Promise<T>;
}): Promise<T> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const extensionPath = path.join(repositoryRoot, 'dist', 'extension');
  const profilePath = path.resolve(options.profilePath);
  if (profilePath === repositoryRoot || profilePath.startsWith(`${repositoryRoot}${path.sep}`) || repositoryRoot.startsWith(`${profilePath}${path.sep}`)) {
    throw new Error('The clean-profile harness requires a dedicated profile directory outside the repository.');
  }
  const session = await options.adapter.launch({ extensionPath, profilePath, isolated: true });
  try {
    return await options.scenario(session);
  } finally {
    await session.close();
  }
}
