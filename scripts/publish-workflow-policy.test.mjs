import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflowUrls = {
  ci: new URL('../.github/workflows/ci.yml', import.meta.url),
  publish: new URL('../.github/workflows/publish.yml', import.meta.url),
};

const actionPins = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
  ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
  ['changesets/action/select-mode', '8488615a623b1b9c987934bb89eae8af6a946ac1'],
  ['changesets/action/version', '8488615a623b1b9c987934bb89eae8af6a946ac1'],
  ['changesets/action/pack', '8488615a623b1b9c987934bb89eae8af6a946ac1'],
  ['changesets/action/publish', '8488615a623b1b9c987934bb89eae8af6a946ac1'],
]);

const pinned = (name) => `${name}@${actionPins.get(name)}`;

const expectedPublishSteps = {
  prepare: [
    {
      name: 'Checkout',
      uses: pinned('actions/checkout'),
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    },
    {
      name: 'Setup Node.js',
      uses: pinned('actions/setup-node'),
      with: { 'node-version': '24.15.0', cache: 'npm' },
    },
    { name: 'Verify bundled npm', run: 'test "$(npm --version)" = "11.12.1"' },
    { name: 'Install dependencies', run: 'npm ci --include=optional' },
    {
      name: 'Verify publish workflow policy',
      run: 'node --test scripts/publish-workflow-policy.test.mjs',
    },
    { name: 'Build', run: 'npm run build' },
    { name: 'Typecheck', run: 'npm run typecheck' },
    { name: 'Test', run: 'npm test' },
    {
      name: 'Select release mode',
      id: 'mode',
      uses: pinned('changesets/action/select-mode'),
    },
    {
      name: 'Pack publishable packages',
      id: 'pack',
      if: "steps.mode.outputs.mode == 'publish'",
      uses: pinned('changesets/action/pack'),
      with: {
        'publish-plan-artifact-id': '${{ steps.mode.outputs.publish-plan-artifact-id }}',
      },
    },
  ],
  version: [
    {
      name: 'Checkout',
      uses: pinned('actions/checkout'),
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    },
    {
      name: 'Setup Node.js',
      uses: pinned('actions/setup-node'),
      with: { 'node-version': '24.15.0', 'package-manager-cache': false },
    },
    { name: 'Verify bundled npm', run: 'test "$(npm --version)" = "11.12.1"' },
    {
      name: 'Install Changesets without lifecycle scripts',
      run: 'npm ci --ignore-scripts',
    },
    {
      name: 'Version packages',
      uses: pinned('changesets/action/version'),
      with: {
        'github-token': '${{ github.token }}',
        script: 'npm run version-packages',
        'commit-message': 'chore(release): version packages',
        'pr-title': 'chore(release): version packages',
        'push-with-git-cli': true,
      },
    },
  ],
  publish: [
    {
      name: 'Checkout',
      uses: pinned('actions/checkout'),
      with: { 'fetch-depth': 0, 'persist-credentials': false },
    },
    {
      name: 'Setup Node.js',
      uses: pinned('actions/setup-node'),
      with: { 'node-version': '24.15.0', 'package-manager-cache': false },
    },
    { name: 'Verify bundled npm', run: 'test "$(npm --version)" = "11.12.1"' },
    {
      name: 'Install Changesets without lifecycle scripts',
      run: 'npm ci --ignore-scripts',
    },
    {
      name: 'Publish prepared artifacts',
      uses: pinned('changesets/action/publish'),
      with: {
        'github-token': '${{ github.token }}',
        'pack-dir-artifact-id': '${{ needs.prepare.outputs.pack-dir-artifact-id }}',
        'create-github-releases': true,
        'push-git-tags': true,
      },
      env: { NPM_CONFIG_PROVENANCE: 'true' },
    },
  ],
};

function actionSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) =>
    job.steps.filter((step) => typeof step.uses === 'string'),
  );
}

function assertPinnedActions(workflow) {
  for (const step of actionSteps(workflow)) {
    const match = /^([^@]+)@([0-9a-f]{40})$/.exec(step.uses);
    assert.ok(match, `${step.uses} must be an external action pinned to a full commit`);
    const [, name, ref] = match;
    assert.ok(actionPins.has(name), `${name} is not in the reviewed action allowlist`);
    assert.equal(ref, actionPins.get(name), `${name} must use its reviewed commit`);
  }
}

function assertPublishWorkflow(workflow, source) {
  assert.deepEqual(Object.keys(workflow).sort(), [
    'concurrency',
    'jobs',
    'name',
    'on',
    'permissions',
  ]);
  assert.equal(workflow.name, 'Publish');
  assert.deepEqual(workflow.on, { push: { branches: ['master'] } });
  assert.deepEqual(workflow.concurrency, {
    group: '${{ github.workflow }}-${{ github.ref }}',
    'cancel-in-progress': false,
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['prepare', 'publish', 'version']);

  const expectedJobs = {
    prepare: {
      name: 'Verify and prepare release',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 20,
      permissions: { contents: 'read' },
      outputs: {
        mode: '${{ steps.mode.outputs.mode }}',
        'pack-dir-artifact-id': '${{ steps.pack.outputs.pack-dir-artifact-id }}',
      },
    },
    version: {
      name: 'Create or update version PR',
      needs: 'prepare',
      if: "needs.prepare.outputs.mode == 'version'",
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
      permissions: { contents: 'write', 'pull-requests': 'write' },
    },
    publish: {
      name: 'Publish approved package artifacts',
      needs: 'prepare',
      if: "needs.prepare.outputs.mode == 'publish'",
      environment: 'npm-publish',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 10,
      permissions: { contents: 'write', 'id-token': 'write' },
    },
  };

  for (const [name, expected] of Object.entries(expectedJobs)) {
    const { steps, ...job } = workflow.jobs[name];
    assert.deepEqual(job, expected, `${name} job policy changed`);
    assert.deepEqual(steps, expectedPublishSteps[name], `${name} steps changed`);
  }

  assertPinnedActions(workflow);
  assert.doesNotMatch(source, /\bsecrets\.|\bNODE_AUTH_TOKEN\b|\bNPM_TOKEN\b/);
  assert.equal(
    Object.values(workflow.jobs).filter(
      (job) => job.permissions?.['id-token'] === 'write',
    ).length,
    1,
  );
}

test('publish workflow is an exact, protected OIDC release transaction', async () => {
  const source = await readFile(workflowUrls.publish, 'utf8');
  assertPublishWorkflow(parse(source), source);
});

test('publish policy rejects privileged workflow bypasses', async () => {
  const source = await readFile(workflowUrls.publish, 'utf8');
  const workflow = parse(source);
  const mutations = [
    ['local action', (copy) => { copy.jobs.publish.steps[0].uses = './local-action'; }],
    ['extra privileged job', (copy) => { copy.jobs.backdoor = copy.jobs.publish; }],
    ['extra privileged step', (copy) => {
      copy.jobs.publish.steps.splice(4, 0, { name: 'Backdoor', run: 'node backdoor.mjs' });
    }],
    ['secret reference', (copy) => {
      copy.jobs.publish.steps[4].env = { NPM_CONFIG_PROVENANCE: 'true', TOKEN: '${{ secrets.NPM_TOKEN }}' };
    }],
    ['self-hosted runner', (copy) => { copy.jobs.publish['runs-on'] = 'self-hosted'; }],
    ['overlapping releases', (copy) => { copy.concurrency['cancel-in-progress'] = true; }],
    ['missing prepare dependency', (copy) => { delete copy.jobs.publish.needs; }],
    ['broken pack handoff', (copy) => {
      copy.jobs.publish.steps[4].with['pack-dir-artifact-id'] = 'unreviewed-artifact';
    }],
  ];

  for (const [label, mutate] of mutations) {
    const copy = structuredClone(workflow);
    mutate(copy);
    assert.throws(
      () => assertPublishWorkflow(copy, JSON.stringify(copy)),
      undefined,
      `${label} must fail closed`,
    );
  }
});

test('CI installs the policy parser before enforcing reviewed action pins', async () => {
  const workflow = parse(await readFile(workflowUrls.ci, 'utf8'));
  assertPinnedActions(workflow);
  const steps = workflow.jobs['build-test'].steps;
  const installIndex = steps.findIndex((step) => step.name === 'Install dependencies');
  const policyIndex = steps.findIndex((step) => step.name === 'Verify publish workflow policy');
  assert.ok(installIndex >= 0 && policyIndex > installIndex);
  assert.deepEqual(steps[policyIndex], {
    name: 'Verify publish workflow policy',
    if: "matrix.os == 'ubuntu-latest'",
    run: 'node --test scripts/publish-workflow-policy.test.mjs',
  });
});
