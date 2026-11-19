import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const retryWait = new Int32Array(new SharedArrayBuffer(4));

function publishState(temp, file) {
  // A Windows reader without delete sharing can briefly block replacement.
  // Keep the save synchronous so later claims cannot overtake this snapshot.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
      Atomics.wait(retryWait, 0, 0, 25 * 2 ** attempt);
    }
  }
}

export class StateStore {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) :
      { version: 1, offset: 0, owner: null, coordinator: null, workers: {}, jobs: {}, replies: {}, notices: {} };
    if (this.data.version !== 1 || !Number.isSafeInteger(this.data.offset) || !this.data.jobs || !this.data.workers)
      throw new Error('Invalid local state; refusing to reset ownership or replay actions.');
  }
  save() {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify(this.data, null, 2) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      publishState(temp, this.file);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* Preserve the original save error. */ }
      throw error;
    }
  }
  recover() {
    const interrupted = [];
    for (const [id, job] of Object.entries(this.data.jobs)) {
      if (['dispatching', 'running', 'awaiting_approval', 'stopping'].includes(job.status)) {
        job.status = 'interrupted';
        job.recoveryNote = 'Bridge restarted. Submission may have executed; inspect before explicitly continuing.';
        interrupted.push(id);
      }
    }
    if (interrupted.length) this.save();
    return interrupted;
  }
}
