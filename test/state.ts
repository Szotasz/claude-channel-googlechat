/**
 * src/config.ts reads its state dir once, at import time. Every test file that
 * loads anything under src/ imports this first, so they all share one empty
 * tmp dir and nothing touches a real channel.
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const STATE = process.env.GOOGLECHAT_TEST_STATE_DIR ?? mkdtempSync(join(tmpdir(), 'gchat-test-'))
process.env.GOOGLECHAT_TEST_STATE_DIR = STATE
process.env.GOOGLECHAT_STATE_DIR = STATE
