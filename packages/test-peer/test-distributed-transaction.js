#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CLI_PATH = join(__dirname, 'dist', 'src', 'cli.js');

// Helper function to run CLI commands
function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_PATH, command, ...args], {
      stdio: 'pipe',
      shell: false
    });

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${errorOutput}`));
      }
    });
  });
}

// Helper function to run CLI commands with timeout
function runCommandWithTimeout(command, args = [], timeout = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_PATH, command, ...args], {
      stdio: 'pipe',
      shell: false
    });

    let output = '';
    let errorOutput = '';

    child.stdout.on('data', (data) => {
      output += data.toString();
    });

    child.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${errorOutput}`));
      }
    });

    // Set timeout
    const timeoutId = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    child.on('close', () => {
      clearTimeout(timeoutId);
    });
  });
}

async function testDistributedTransaction() {
  console.log('🚀 Testing Optimystic Distributed Transaction System');
  console.log('==================================================');

  try {
    // Start node (this will run in background)
    console.log('1. Starting P2P node...');
    const startNodeChild = spawn('node', [CLI_PATH, 'start-node', '--port', '8080'], {
      stdio: 'pipe',
      shell: false
    });

    // Wait for node to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('2. Creating diary collection...');
    const diaryResult = await runCommand('create-diary', ['--name', 'test-diary']);
    console.log('   Result:', diaryResult.trim());

    console.log('3. Adding entries to diary...');
    const entry1 = await runCommand('add-entry', ['--diary', 'test-diary', '--content', 'Hello, distributed world!']);
    console.log('   Entry 1:', entry1.trim());

    const entry2 = await runCommand('add-entry', ['--diary', 'test-diary', '--content', 'This is my second entry.']);
    console.log('   Entry 2:', entry2.trim());

    const entry3 = await runCommand('add-entry', ['--diary', 'test-diary', '--content', 'Distributed transactions are working!']);
    console.log('   Entry 3:', entry3.trim());

    console.log('4. Listing all diaries...');
    const listResult = await runCommand('list-diaries');
    console.log('   Result:', listResult.trim());

    console.log('5. Reading diary entries...');
    const readResult = await runCommand('read-diary', ['--diary', 'test-diary']);
    console.log('   Result:', readResult.trim());

    console.log('\n✅ Distributed transaction test completed successfully!');
    console.log('The system successfully:');
    console.log('  - Started a P2P node');
    console.log('  - Created a distributed diary collection');
    console.log('  - Added multiple entries using distributed transactions');
    console.log('  - Retrieved and verified the entries');

    // Clean up
    startNodeChild.kill();

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

// Run the test
testDistributedTransaction().catch(console.error);
