import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') || path.extname(specifier)) throw error;
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    try {
      await access(fileURLToPath(candidate));
      return nextResolve(candidate.href, context);
    } catch {
      throw error;
    }
  }
}
