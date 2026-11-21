import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./scripts/ts-extension-hooks.mjs', pathToFileURL(`${process.cwd()}/`));
