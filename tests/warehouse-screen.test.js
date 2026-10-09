import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = join(__dirname, '..');

describe('Warehouse Screen & Role-Gating Verification', () => {
  const warehousePath = join(ROOT_DIR, 'src', 'pages', 'admin', 'Warehouse.jsx');
  const adminLayoutPath = join(ROOT_DIR, 'src', 'components', 'AdminLayout.jsx');
  const appPath = join(ROOT_DIR, 'src', 'App.jsx');

  it('Warehouse.jsx exists and queries returns with status in [IN_TRANSIT, RECEIVED, INSPECTION] limit 25', () => {
    assert.ok(existsSync(warehousePath), 'src/pages/admin/Warehouse.jsx must exist');
    const source = readFileSync(warehousePath, 'utf-8');

    // Query must filter by the three warehouse statuses with limit 25
    assert.ok(
      source.includes("'IN_TRANSIT'") && source.includes("'RECEIVED'") && source.includes("'INSPECTION'"),
      'Must filter for IN_TRANSIT, RECEIVED, and INSPECTION statuses'
    );
    assert.ok(
      source.includes('limit(25)'),
      'Must specify limit(25)'
    );
  });

  it('Warehouse.jsx provides Receive and Inspect actions with condition notes', () => {
    const source = readFileSync(warehousePath, 'utf-8');

    // Calls POST /warehouse/returns/:id/receive
    assert.ok(
      source.includes('/warehouse/returns/') && source.includes('/receive'),
      'Must call POST /warehouse/returns/:id/receive'
    );

    // Calls POST /warehouse/returns/:id/inspect
    assert.ok(
      source.includes('/warehouse/returns/') && source.includes('/inspect'),
      'Must call POST /warehouse/returns/:id/inspect'
    );

    // Has condition notes input/state
    assert.ok(
      source.includes('conditionNotes') || source.includes('condition'),
      'Must have condition notes field for item inspection'
    );
  });

  it('AdminLayout.jsx role-gates warehouse, staff, and admin', () => {
    assert.ok(existsSync(adminLayoutPath), 'AdminLayout.jsx must exist');
    const source = readFileSync(adminLayoutPath, 'utf-8');

    // Allows role warehouse, staff, admin
    assert.ok(
      source.includes('warehouse'),
      'AdminLayout must support warehouse role'
    );
    assert.ok(
      source.includes('isWarehouseRole') || source.includes("role === 'warehouse'"),
      'AdminLayout must identify warehouse role'
    );

    // Restricts warehouse role to /admin/warehouse
    assert.ok(
      source.includes('/admin/warehouse'),
      'AdminLayout must navigate/render warehouse dock link'
    );
  });

  it('App.jsx registers /admin/warehouse route', () => {
    assert.ok(existsSync(appPath), 'App.jsx must exist');
    const source = readFileSync(appPath, 'utf-8');

    assert.ok(
      source.includes('AdminWarehouse'),
      'App.jsx must import AdminWarehouse'
    );
    assert.ok(
      source.includes('path="warehouse"'),
      'App.jsx must configure path="warehouse" route'
    );
  });
});
