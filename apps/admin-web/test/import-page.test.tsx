/**
 * «ایمپورت میرزابات», for the two things Sam asked for on 2026-09-01:
 * «آپلود از مرورگر میخوام حتما باشه و موقع ایمپورت کردن هم نوتیفکیشن مناسب رو
 * هم بده».
 *
 * The upload half is covered on the server as well — `import.test.ts` asserts
 * what lands in the directory, which is the half that matters for safety. What
 * is only assertable here is the half about a person: that a 413 says which
 * server setting is wrong instead of printing a number, that a run says what it
 * is doing while it is doing it, and that «تمام شد» is announced once, on the
 * transition, and never for a run that ended hours ago and was merely reopened.
 *
 * That last one is the whole reason `announced` is keyed by run id. A flag
 * would have fired every time the report of an old run was opened from the
 * table, which is a notification that is not only useless but false.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { ImportPage } from '../src/pages/ImportPage.js';
import { ApiError, type ImportRun } from '../src/api.js';

const FILE: { name: string; bytes: number; modifiedAt: string } = {
  name: 'mirzabot-prod.sql',
  bytes: 6_124_969,
  modifiedAt: '2026-09-01T10:00:00Z',
};

function run(over: Partial<ImportRun> = {}): ImportRun {
  return {
    id: 'run-1',
    mode: 'DRY_RUN',
    status: 'RUNNING',
    dump_path: `/srv/imports/${FILE.name}`,
    dump_bytes: FILE.bytes,
    domains: ['catalog', 'sales'],
    report: [],
    samples: {},
    error: null,
    started_by: 'admin@example.com',
    started_at: '2026-09-01T10:01:00Z',
    finished_at: null,
    ...over,
  } as ImportRun;
}

const importFiles = vi.fn(async () => ({ ok: true, dir: '/srv/imports', items: [FILE] }));
const importRuns = vi.fn(async () => ({ ok: true, items: [] as ImportRun[] }));
const importRun = vi.fn(async (_id: string) => ({ ok: true, run: run() }));
const startImport = vi.fn(async (_m: unknown, _b: unknown) => ({ ok: true, id: 'run-1' }));
const uploadDump = vi.fn(async (_f: File, _p: (n: number) => void) => ({ name: 'uploaded.sql' }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      importFiles: () => importFiles(),
      importRuns: () => importRuns(),
      importRun: (id: string) => importRun(id),
      startImport: (m: unknown, b: unknown) => startImport(m, b),
      uploadDump: (f: File, p: (n: number) => void) => uploadDump(f, p),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <ImportPage />
    </RoleProvider>,
  );

/** The file input, which has no label of its own. */
const picker = () => document.querySelector('input[type="file"]') as HTMLInputElement;

const dump = (name = 'mirzabot-prod.sql') =>
  new File(['CREATE TABLE t (a int);'], name, { type: 'application/sql' });

let notifications: { title: string; body: string }[];

beforeEach(() => {
  vi.clearAllMocks();
  notifications = [];
  class FakeNotification {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => 'granted');
    constructor(title: string, opts?: { body?: string }) {
      notifications.push({ title, body: opts?.body ?? '' });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('putting a dump there from the browser', () => {
  it('sends the chosen file and then selects it', async () => {
    draw();
    await screen.findByRole('option', { name: /mirzabot-prod\.sql/ });

    importFiles.mockResolvedValueOnce({
      ok: true,
      dir: '/srv/imports',
      items: [{ name: 'uploaded.sql', bytes: 12, modifiedAt: '2026-09-01T11:00:00Z' }],
    });
    fireEvent.change(picker(), { target: { files: [dump('uploaded.sql')] } });

    await waitFor(() => expect(uploadDump).toHaveBeenCalledTimes(1));
    expect(uploadDump.mock.calls[0]![0]!.name).toBe('uploaded.sql');
    // The list is re-read afterwards; a name the page invented would not be
    // proof the file is on the server.
    await screen.findByText(/«uploaded\.sql» روی سرور نشست/);
  });

  it('names the server setting when nginx refuses the body', async () => {
    // 413 comes from nginx, not from the route, so there is no JSON to read and
    // nothing on the page can be fixed by the person reading it. The message
    // has to name `client_max_body_size` or it is a dead end.
    uploadDump.mockRejectedValueOnce(new ApiError(413, 'body_too_large', null));
    draw();
    await screen.findByRole('option', { name: /mirzabot-prod\.sql/ });

    fireEvent.change(picker(), { target: { files: [dump()] } });

    await screen.findByText(/client_max_body_size/);
  });

  it('reports what went up, live', async () => {
    let seen = -1;
    uploadDump.mockImplementationOnce(async (_f, onProgress) => {
      onProgress(0.5);
      seen = 0.5;
      return { name: 'mirzabot-prod.sql' };
    });
    draw();
    await screen.findByRole('option', { name: /mirzabot-prod\.sql/ });

    fireEvent.change(picker(), { target: { files: [dump()] } });

    await waitFor(() => expect(seen).toBe(0.5));
  });

  it('offers no run button while a file is still going up', async () => {
    // The server's guarantees do not depend on this — a run re-checks the
    // digest of what it actually loaded. What this prevents is offering a
    // person a button whose outcome depends on which of two requests lands
    // first. CodeRabbit raised it on PR #48.
    let release: (v: { name: string }) => void = () => undefined;
    uploadDump.mockImplementationOnce(
      () => new Promise<{ name: string }>((resolve) => (release = resolve)),
    );
    draw();
    await screen.findByRole('option', { name: /mirzabot-prod\.sql/ });

    fireEvent.change(picker(), { target: { files: [dump()] } });

    for (const name of ['بررسی', 'اجرای آزمایشی', 'اعمال نهایی']) {
      // `.disabled`, not a jest-dom matcher: this suite does not load them.
      await waitFor(() =>
        expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true),
      );
    }
    // The picker too: a second file chosen mid-upload would race the first.
    expect(picker().disabled).toBe(true);

    release({ name: 'mirzabot-prod.sql' });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'بررسی' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });
});

describe('saying what the import is doing', () => {
  it('shows the last line of the report while the run is still going', async () => {
    importRun.mockResolvedValue({
      ok: true,
      run: run({ report: [{ level: 'step', text: 'users … 14920 rows' }] }),
    });
    draw();
    await screen.findByRole('option', { name: /mirzabot-prod\.sql/ });

    fireEvent.click(screen.getByRole('button', { name: 'اجرای آزمایشی' }));

    // The point of the whole change: something other than «در حال اجرا».
    //
    // Scoped to the progress banner on purpose. The line is deliberately in two
    // places while a run is going — pinned here, and in its place in the report
    // — and the report is a scrolling box that will have moved on by the time
    // anybody looks. Asserting «somewhere on the page» would pass on the report
    // alone and prove nothing about the banner.
    const banner = await waitFor(() => {
      const el = document.querySelector('.alert-info');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    await within(banner).findByText('users … 14920 rows');
  });

  it('announces the end once, and only for a run it watched start', async () => {
    importRun.mockResolvedValueOnce({ ok: true, run: run() });
    draw();
    await screen.findByRole('option', { name: /mirzabot-prod\.sql/ });

    fireEvent.click(screen.getByRole('button', { name: 'اجرای آزمایشی' }));
    await screen.findByText(/در حال اجرا/);

    importRun.mockResolvedValue({
      ok: true,
      run: run({ status: 'SUCCEEDED', finished_at: '2026-09-01T10:05:00Z' }),
    });

    await waitFor(() => expect(notifications).toHaveLength(1), { timeout: 3000 });
    expect(notifications[0]!.title).toBe('ایمپورت تمام شد');
    // The banner too: a notification the browser suppressed must not be the
    // only place the result appears. Two matches is the correct answer — the
    // card heading and the banner — and asserting one would mean asserting the
    // page has only one of them.
    expect((await screen.findAllByText(/اجرای آزمایشی — موفق/)).length).toBeGreaterThan(0);

    // Polling continues; the announcement must not repeat.
    await new Promise((r) => setTimeout(r, 1200));
    expect(notifications).toHaveLength(1);
  });

  it('says nothing when an already-finished run is opened from the table', async () => {
    const old = run({
      id: 'run-old',
      status: 'SUCCEEDED',
      finished_at: '2026-08-30T10:05:00Z',
      started_at: '2026-08-30T10:01:00Z',
    });
    importRuns.mockResolvedValue({ ok: true, items: [old] });
    importRun.mockResolvedValue({ ok: true, run: old });
    draw();

    fireEvent.click(await screen.findByRole('button', { name: 'گزارش' }));

    await screen.findByText(/اجرای آزمایشی — موفق/, { selector: 'h3' });
    expect(notifications).toHaveLength(0);
  });
});
