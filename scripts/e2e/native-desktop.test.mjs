import assert from 'node:assert/strict';
import test from 'node:test';
import { discovery, mockContractEvidence, unavailablePrerequisites } from './native-desktop.mjs';

test('discovery enumerates the full native/Chrome journey without claiming execution', () => {
  const report = discovery();
  assert.equal(report.fullAcceptance, false);
  assert.equal(report.mode, 'discovery-only');
  assert.deepEqual(report.gates.map(gate => gate.id), [
    'desktop-import', 'ocr-markup', 'rag-citations', 'research-workspace',
    'translated-pdf-save-as', 'persistence-reload', 'extension-native-handoff',
    'reconnect-duplicate-checksum', 'cleanup',
  ]);
  assert.ok(report.gates.every(gate => gate.status === 'not-run'));
});

test('mock-only contract cannot claim desktop, Chrome, permission, or product acceptance', () => {
  const report = mockContractEvidence();
  assert.equal(report.fullAcceptance, false);
  assert.equal(report.realDesktopLaunched, false);
  assert.equal(report.realChromeLaunched, false);
  assert.equal(report.syntheticCapturePermissionProof, false);
  assert.ok(report.gates.every(gate => gate.status === 'not-run'));
});

test('acceptance prerequisite discovery fails closed and names every external runtime', () => {
  const blockers = unavailablePrerequisites({}, 'linux');
  assert.ok(blockers.some(blocker => blocker.includes('supported desktop OS')));
  for (const expected of ['PDF_WORKSPACE_EXE', 'PDF_WORKSPACE_E2E_SCRIPT', 'PDF_WORKSPACE_E2E_ASSERTIONS', 'CHROME_PATH', 'PDF_WORKSPACE_NATIVE_HOST']) {
    assert.ok(blockers.some(blocker => blocker.includes(expected)), `missing blocker for ${expected}`);
  }
});

test('acceptance prerequisite discovery accepts only named real-run inputs, not mocks', () => {
  assert.deepEqual(unavailablePrerequisites({
    PDF_WORKSPACE_EXE: '/app/pdf_workspace',
    PDF_WORKSPACE_E2E_SCRIPT: '/tmp/journey.fdl',
    PDF_WORKSPACE_E2E_ASSERTIONS: '/tmp/assertions.json',
    CHROME_PATH: '/browser/chrome',
    PDF_WORKSPACE_NATIVE_HOST: '/host/pdf-workspace-host',
  }, 'win32'), []);
});
