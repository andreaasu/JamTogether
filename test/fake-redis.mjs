export class FakeRedis {
  constructor() { this.data = new Map(); }
  async command(type, ...args) {
    const op = String(type).toUpperCase();
    const key = args[0];
    if (op === 'GET') return this.data.get(key) ?? null;
    if (op === 'SET') {
      if (args.map(String).map(s => s.toUpperCase()).includes('NX') && this.data.has(key)) return null;
      this.data.set(key, args[1]); return 'OK';
    }
    if (op === 'DEL') return Number(this.data.delete(key));
    if (op === 'EVAL') {
      const lock = args[2], owner = args[3];
      if (this.data.get(lock) === owner) return Number(this.data.delete(lock));
      return 0;
    }
    throw Error('Unsupported fake Redis command: ' + op);
  }
}
