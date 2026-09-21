import { createPool as createMysqlPool, type Pool } from 'mysql2/promise';

export const createPool = (databaseUrl: string): Pool =>
  createMysqlPool({ uri: databaseUrl, connectionLimit: 5 });
