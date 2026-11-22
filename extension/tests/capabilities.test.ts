import { describe, expect, it } from 'vitest';
import {
  ACTION_REQUIREMENTS,
  CAPABILITY_ACTIONS,
  CAPABILITY_MODES,
  CAPABILITY_NAMES,
  CapabilityError,
  capabilityMatrix,
  check,
  hasCapability,
  isCapabilityAction,
  isCapabilityMode,
  isCapabilityName,
  modeDefinition,
  requireCapability,
  type CapabilityAction,
  type CapabilityMode,
  type CapabilityName,
  type ModeDefinition,
} from '../viewer/src/core/capabilities';
import { TranslationError } from '../viewer/src/core/retry';

/**
 * The matrix the product promises, written out here rather than read from the module, so
 * the table is checked against the contract instead of against itself.
 */
const CONTRACT: Readonly<Record<CapabilityMode, readonly CapabilityName[]>> = {
  reader: ['writeLibrary', 'audit'],
  local: ['loopback', 'writeLibrary', 'writeExport', 'audit'],
  cloud: ['network', 'loopback', 'writeLibrary', 'writeExport', 'cloudConsent', 'audit'],
  automation: ['writeExport', 'audit'],
};

/** A name this build does not know, cast so a type-checked call site can pass it. */
const unknownMode = (name: string): CapabilityMode => name as unknown as CapabilityMode;
const unknownAction = (name: string): CapabilityAction => name as unknown as CapabilityAction;
const unknownCapability = (name: string): CapabilityName => name as unknown as CapabilityName;

/** Every capability a mode declares, in {@link CAPABILITY_NAMES} order. */
function grantedOf(mode: CapabilityMode): CapabilityName[] {
  const definition = modeDefinition(mode);
  if (definition === null) throw new Error(`the matrix has no row for ${mode}`);
  return CAPABILITY_NAMES.filter(capability => definition.capabilities[capability]);
}

/** The capabilities one action requires, read from the published action table. */
function requirementsOf(action: CapabilityAction): readonly CapabilityName[] {
  const definition = ACTION_REQUIREMENTS.find(entry => entry.action === action);
  if (definition === undefined) throw new Error(`the action table has no row for ${action}`);
  return definition.requires;
}

function failureOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to throw');
}

describe('capability matrix', () => {
  it('lists every mode once, in the documented order', () => {
    const modes = capabilityMatrix().map(definition => definition.mode);
    expect(modes).toEqual([...CAPABILITY_MODES]);
    expect(new Set(modes).size).toBe(modes.length);
    expect(modes).toEqual(['reader', 'local', 'cloud', 'automation']);
  });

  it('gives every mode one boolean per capability', () => {
    for (const definition of capabilityMatrix()) {
      expect(Object.keys(definition.capabilities).sort(), definition.mode).toEqual(
        [...CAPABILITY_NAMES].sort(),
      );
      for (const capability of CAPABILITY_NAMES) {
        expect(typeof definition.capabilities[capability], `${definition.mode}.${capability}`).toBe(
          'boolean',
        );
      }
    }
  });

  it('grants exactly the capabilities the product contract names', () => {
    for (const mode of CAPABILITY_MODES) {
      expect(grantedOf(mode), mode).toEqual([...CONTRACT[mode]]);
    }
  });

  it('grants audit in every mode, because an unrecorded mode cannot be reviewed', () => {
    for (const mode of CAPABILITY_MODES) {
      expect(hasCapability(mode, 'audit'), mode).toBe(true);
    }
  });

  it('withholds every other capability in at least one mode', () => {
    const withheld = CAPABILITY_NAMES.filter(
      capability => !CAPABILITY_MODES.every(mode => hasCapability(mode, capability)),
    );
    expect(withheld).toEqual(['network', 'loopback', 'writeLibrary', 'writeExport', 'cloudConsent']);
  });

  it('documents each mode in one sentence', () => {
    const descriptions = capabilityMatrix().map(definition => definition.description);
    for (const [index, description] of descriptions.entries()) {
      expect(description.length, CAPABILITY_MODES[index]).toBeGreaterThan(20);
      expect(description.endsWith('.'), CAPABILITY_MODES[index]).toBe(true);
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('is frozen, so no caller can widen a mode at runtime', () => {
    const matrix = capabilityMatrix();
    const [first] = matrix;
    if (first === undefined) throw new Error('the matrix is empty');

    expect(Object.isFrozen(matrix)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.capabilities)).toBe(true);

    expect(() => (matrix as ModeDefinition[]).push(first)).toThrow(TypeError);
    expect(() => {
      (first.capabilities as unknown as Record<string, boolean>).network = true;
    }).toThrow(TypeError);

    expect(matrix).toHaveLength(CAPABILITY_MODES.length);
    expect(hasCapability('reader', 'network')).toBe(false);
  });

  it('keeps the vocabulary arrays frozen, so no mode can be added at runtime', () => {
    expect(Object.isFrozen(CAPABILITY_MODES)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_NAMES)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_ACTIONS)).toBe(true);
    expect(Object.isFrozen(ACTION_REQUIREMENTS)).toBe(true);

    expect(() => (CAPABILITY_MODES as CapabilityMode[]).push('offline' as CapabilityMode)).toThrow(
      TypeError,
    );
    expect(isCapabilityMode('offline')).toBe(false);
  });

  it('answers one capability from the same table the matrix publishes', () => {
    for (const definition of capabilityMatrix()) {
      expect(modeDefinition(definition.mode)).toBe(definition);
      for (const capability of CAPABILITY_NAMES) {
        expect(hasCapability(definition.mode, capability), `${definition.mode}.${capability}`).toBe(
          definition.capabilities[capability],
        );
      }
    }

    expect(modeDefinition(unknownMode('reader '))).toBeNull();
    expect(hasCapability(unknownMode('offline'), 'audit')).toBe(false);
  });
});

describe('action classification', () => {
  it('classifies every documented action in every mode', () => {
    for (const mode of CAPABILITY_MODES) {
      const granted = grantedOf(mode);
      for (const action of CAPABILITY_ACTIONS) {
        const where = `${mode}/${action}`;
        const decision = check(mode, action);
        const expected = requirementsOf(action).filter(capability => !granted.includes(capability));

        expect(typeof decision.allowed, where).toBe('boolean');
        expect(decision.mode, where).toBe(mode);
        expect(decision.action, where).toBe(action);
        expect(decision.reason.length, where).toBeGreaterThan(0);
        expect(decision.reason, where).toContain(`${mode} mode`);
        expect(decision.reason, where).toContain(action);
        expect([...decision.missing], where).toEqual(expected);
        expect(decision.allowed, where).toBe(expected.length === 0);
        for (const capability of decision.missing) {
          expect(CAPABILITY_NAMES, where).toContain(capability);
          expect(decision.reason, where).toContain(capability);
        }
      }
    }
  });

  it('lists each action once and requires only known capabilities', () => {
    const actions = ACTION_REQUIREMENTS.map(definition => definition.action);
    expect(actions).toEqual([...CAPABILITY_ACTIONS]);
    expect(new Set(actions).size).toBe(actions.length);

    for (const definition of ACTION_REQUIREMENTS) {
      expect(new Set(definition.requires).size, definition.action).toBe(definition.requires.length);
      for (const capability of definition.requires) {
        expect(CAPABILITY_NAMES, definition.action).toContain(capability);
      }
      expect(definition.rationale.length, definition.action).toBeGreaterThan(10);
    }
  });

  it('leaves at least one mode able to perform every action', () => {
    for (const action of CAPABILITY_ACTIONS) {
      const modes = CAPABILITY_MODES.filter(mode => check(mode, action).allowed);
      expect(modes.length, action).toBeGreaterThan(0);
    }
  });
});

describe('reader mode', () => {
  it('refuses a cloud translation and says which capabilities it lacks', () => {
    const decision = check('reader', 'translateCloud');

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('reader');
    expect(decision.action).toBe('translateCloud');
    expect(decision.missing).toEqual(['network', 'cloudConsent']);
    expect(decision.reason).toBe(
      'reader mode refuses translateCloud: a cloud translation sends text beyond this machine, ' +
        'and it does not declare network or cloudConsent.',
    );
  });

  it('allows opening a document, the one thing a reader exists for', () => {
    expect(check('reader', 'openDocument')).toEqual({
      allowed: true,
      reason:
        'reader mode allows openDocument: opening a document is what a reader exists for, ' +
        'and it needs no capability of its own.',
      mode: 'reader',
      action: 'openDocument',
      missing: [],
    });
  });

  it('refuses every write outside the library', () => {
    const decision = check('reader', 'exportFile');
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toEqual(['writeExport']);
    expect(decision.reason).toContain('outside the library');
  });

  it('refuses to read a stored credential', () => {
    const decision = check('reader', 'readCredential');
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toEqual(['cloudConsent']);
    expect(decision.reason).toBe(
      'reader mode refuses readCredential: a credential exists only for a remote provider, ' +
        'and it does not declare cloudConsent.',
    );
  });

  it('refuses the network at the enforcement door too', () => {
    for (const capability of ['network', 'loopback', 'writeExport', 'cloudConsent'] as const) {
      expect(() => requireCapability('reader', capability), capability).toThrow(CapabilityError);
    }
    for (const capability of ['writeLibrary', 'audit'] as const) {
      expect(() => requireCapability('reader', capability), capability).not.toThrow();
    }
  });
});

describe('local mode', () => {
  it('allows a loopback translation and nothing further', () => {
    const decision = check('local', 'translateLocal');
    expect(decision.allowed).toBe(true);
    expect(decision.missing).toEqual([]);
    expect(decision.reason).toBe(
      'local mode allows translateLocal: a local translation talks to a model on this machine, ' +
        'and it declares loopback.',
    );
  });

  it('refuses a cloud translation for the network it would need', () => {
    const decision = check('local', 'translateCloud');
    expect(decision.allowed).toBe(false);
    expect(decision.missing).toContain('network');
    expect(decision.reason).toContain('local mode refuses translateCloud');
  });

  it('exports a file without granting the network', () => {
    expect(check('local', 'exportFile').allowed).toBe(true);
    expect(hasCapability('local', 'writeExport')).toBe(true);
    expect(hasCapability('local', 'network')).toBe(false);
  });
});

describe('cloud mode', () => {
  it('allows a cloud translation because the mode declares consent', () => {
    const decision = check('cloud', 'translateCloud');
    expect(decision.allowed).toBe(true);
    expect(decision.missing).toEqual([]);
    expect(decision.reason).toBe(
      'cloud mode allows translateCloud: a cloud translation sends text beyond this machine, ' +
        'and it declares network or cloudConsent.',
    );
  });

  it('is the only mode that declares cloud consent, so the others refuse without it', () => {
    const declaring = CAPABILITY_MODES.filter(mode => hasCapability(mode, 'cloudConsent'));
    expect(declaring).toEqual(['cloud']);

    for (const mode of ['reader', 'local', 'automation'] as const) {
      const decision = check(mode, 'translateCloud');
      expect(decision.allowed, mode).toBe(false);
      expect(decision.missing, mode).toContain('cloudConsent');
      expect(decision.reason, mode).toContain('cloudConsent');
    }
  });

  it('grants every documented action, because it declares every capability', () => {
    for (const action of CAPABILITY_ACTIONS) {
      expect(check('cloud', action).allowed, action).toBe(true);
    }
  });
});

describe('automation mode', () => {
  it('allows the export write', () => {
    const decision = check('automation', 'exportFile');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe(
      'automation mode allows exportFile: an export writes a file outside the library, ' +
        'and it declares writeExport.',
    );
  });

  it('refuses the network in both directions', () => {
    const cloud = check('automation', 'translateCloud');
    expect(cloud.allowed).toBe(false);
    expect(cloud.missing).toEqual(['network', 'cloudConsent']);
    expect(cloud.reason).toContain('automation mode refuses translateCloud');

    const local = check('automation', 'translateLocal');
    expect(local.allowed).toBe(false);
    expect(local.missing).toEqual(['loopback']);
    expect(local.reason).toBe(
      'automation mode refuses translateLocal: a local translation talks to a model on this machine, ' +
        'and it does not declare loopback.',
    );
  });

  it('leaves the library alone: no settings, no deletion', () => {
    for (const action of ['writeSettings', 'deleteDocument'] as const) {
      const decision = check('automation', action);
      expect(decision.allowed, action).toBe(false);
      expect(decision.missing, action).toEqual(['writeLibrary']);
    }
    expect(() => requireCapability('automation', 'writeLibrary')).toThrow(CapabilityError);
  });

  it('opens a document without being allowed to write it back', () => {
    expect(check('automation', 'openDocument').allowed).toBe(true);
    expect(hasCapability('automation', 'writeLibrary')).toBe(false);
  });

  it('does not read a stored credential', () => {
    expect(check('automation', 'readCredential').missing).toEqual(['cloudConsent']);
  });
});

describe('unknown input', () => {
  it('refuses a mode from another vocabulary instead of mapping it', () => {
    const decision = check(unknownMode('offline'), 'translateCloud');

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBeNull();
    expect(decision.action).toBe('translateCloud');
    expect(decision.missing).toEqual([]);
    expect(decision.reason).toBe(
      'The mode "offline" is not one of reader, local, cloud, automation, so it grants nothing.',
    );
  });

  it('refuses an action it does not classify', () => {
    const decision = check('reader', unknownAction('formatDisk'));

    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('reader');
    expect(decision.action).toBeNull();
    expect(decision.reason).toBe(
      'The action "formatDisk" is not one of openDocument, translateLocal, translateCloud, ' +
        'exportFile, writeSettings, readCredential, deleteDocument, so it is refused.',
    );
  });

  it('refuses when both names are unknown, naming the mode it could not read', () => {
    const decision = check(unknownMode('offline'), unknownAction('formatDisk'));
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBeNull();
    expect(decision.action).toBeNull();
    expect(decision.reason).toContain('"offline"');
  });

  it('grants nothing to an unknown mode', () => {
    expect(modeDefinition(unknownMode('offline'))).toBeNull();
    for (const capability of CAPABILITY_NAMES) {
      expect(hasCapability(unknownMode('offline'), capability), capability).toBe(false);
    }
  });

  it('refuses to require a capability of an unknown mode', () => {
    const failure = failureOf(() => requireCapability(unknownMode('offline'), 'audit'));
    expect(failure).toBeInstanceOf(CapabilityError);
    const refusal = failure as CapabilityError;
    expect(refusal.code).toBe('unknown-mode');
    expect(refusal.mode).toBeNull();
    expect(refusal.capability).toBeNull();
    expect(refusal.message).toContain('"offline"');
    expect(refusal.message).toContain('reader, local, cloud, automation');
  });

  it('refuses to require an unknown capability', () => {
    const failure = failureOf(() => requireCapability('cloud', unknownCapability('root')));
    expect(failure).toBeInstanceOf(CapabilityError);
    const refusal = failure as CapabilityError;
    expect(refusal.code).toBe('unknown-capability');
    expect(refusal.mode).toBe('cloud');
    expect(refusal.capability).toBeNull();
    expect(refusal.message).toBe(
      'The capability "root" is not one of network, loopback, writeLibrary, writeExport, ' +
        'cloudConsent, audit, so it cannot be required.',
    );
  });

  it('accepts only known names in the type guards', () => {
    expect(isCapabilityMode('reader')).toBe(true);
    expect(isCapabilityMode('offline')).toBe(false);
    expect(isCapabilityMode(4)).toBe(false);
    expect(isCapabilityMode(null)).toBe(false);
    expect(isCapabilityMode(undefined)).toBe(false);

    for (const action of CAPABILITY_ACTIONS) expect(isCapabilityAction(action), action).toBe(true);
    expect(isCapabilityAction('formatDisk')).toBe(false);

    for (const capability of CAPABILITY_NAMES) {
      expect(isCapabilityName(capability), capability).toBe(true);
    }
    expect(isCapabilityName('root')).toBe(false);
  });
});

describe('CapabilityError', () => {
  it('is a typed, non-retryable refusal naming the mode and the capability', () => {
    const failure = failureOf(() => requireCapability('reader', 'network'));

    expect(failure).toBeInstanceOf(CapabilityError);
    expect(failure).toBeInstanceOf(TranslationError);
    const refusal = failure as CapabilityError;
    expect(refusal.name).toBe('CapabilityError');
    expect(refusal.code).toBe('missing-capability');
    expect(refusal.kind).toBe('invalid');
    expect(refusal.retryable).toBe(false);
    expect(refusal.mode).toBe('reader');
    expect(refusal.capability).toBe('network');
    expect(refusal.message).toBe(
      'reader mode does not declare network, so a step that needs it cannot run in this mode.',
    );
    expect(refusal.userMessage).toBe(refusal.message);
  });

  it('never throws for a capability the mode declares', () => {
    for (const mode of CAPABILITY_MODES) {
      for (const capability of CAPABILITY_NAMES) {
        const work = (): void => requireCapability(mode, capability);
        if (grantedOf(mode).includes(capability)) {
          expect(work, `${mode}.${capability}`).not.toThrow();
        } else {
          expect(work, `${mode}.${capability}`).toThrow(CapabilityError);
        }
      }
    }
  });
});

describe('decisions', () => {
  it('hands back a fresh decision, so one caller cannot edit another', () => {
    const first = check('reader', 'exportFile');
    const expectedReason = first.reason;
    (first as { reason: string }).reason = 'tampered';

    const second = check('reader', 'exportFile');
    expect(second).not.toBe(first);
    expect(second.reason).toBe(expectedReason);
    expect(second.reason).not.toBe('tampered');
  });

  it('freezes the missing list, so a refusal cannot be widened into an allowance', () => {
    const decision = check('reader', 'exportFile');
    expect(Object.isFrozen(decision.missing)).toBe(true);
    expect(() => (decision.missing as CapabilityName[]).push('network')).toThrow(TypeError);
    expect(decision.missing).toEqual(['writeExport']);
    expect(Object.isFrozen(check('cloud', 'exportFile').missing)).toBe(true);
  });
});
