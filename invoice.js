function ready(fn) {
  if (document.readyState !== 'loading'){
    fn();
  } else {
    document.addEventListener('DOMContentLoaded', fn);
  }
}

/**
 * Demo is only shown when the row has no Issued or Due date.
 */
function addDemo(row) {
  if (!('Issued' in row) && !('Due' in row)) {
    for (const key of ['Number', 'Issued', 'Due']) {
      if (!(key in row)) { row[key] = key; }
    }
    for (const key of ['Subtotal', 'Deduction', 'Taxes', 'Total']) {
      if (!(key in row)) { row[key] = key; }
    }
    if (!('Note' in row)) { row.Note = '(Anything in a Note column goes here)'; }
  }
  if (!row.Invoicer) {
    row.Invoicer = {
      Name: 'Invoicer.Name',
      Street1: 'Invoicer.Street1',
      Street2: 'Invoicer.Street2',
      City: 'Invoicer.City',
      State: '.State',
      Zip: '.Zip',
      Email: 'Invoicer.Email',
      Phone: 'Invoicer.Phone',
      Website: 'Invoicer.Website'
    }
  }
  if (!row.Client) {
    row.Client = {
      Name: 'Client.Name',
      Street1: 'Client.Street1',
      Street2: 'Client.Street2',
      City: 'Client.City',
      State: '.State',
      Zip: '.Zip'
    }
  }
  if (!row.Items) {
    row.Items = [
      {
        Description: 'Items[0].Description',
        Quantity: '.Quantity',
        Total: '.Total',
        Price: '.Price',
      },
      {
        Description: 'Items[1].Description',
        Quantity: '.Quantity',
        Total: '.Total',
        Price: '.Price',
      },
    ];
  }
  return row;
}

const data = {
  count: 0,
  invoice: '',
  status: 'waiting',
  tableConnected: false,
  rowConnected: false,
  haveRows: false,
};
let app = undefined;
let _assetTableCache = null;
let _assetTableId = null;
let _lastSelectedRow = null;
// Default to least privilege; Grist will tell us actual access via onOptions.
let _accessLevel = 'read table';

function _updateInvoiceFromAssetsRecords(records) {
  try {
    data.status = '';
    const toRowObjects = (payload) => {
      if (!payload) { return []; }
      if (Array.isArray(payload)) { return payload; }

      // {records:[{id, fields:{...}}, ...]} shape.
      if (Array.isArray(payload.records)) {
        return payload.records.map(r => (r && r.fields) ? Object.assign({id: r.id}, r.fields) : r);
      }

      // Columnar shape: {id:[..], ColA:[..], ColB:[..]}
      const cols = payload.columns ? payload.columns : payload;
      const ids = cols && (cols.id || cols.ID || cols.Id);
      if (Array.isArray(ids)) {
        const out = [];
        for (let i = 0; i < ids.length; i++) {
          const rec = {id: ids[i]};
          for (const [colId, colVals] of Object.entries(cols)) {
            if (Array.isArray(colVals)) {
              rec[colId] = colVals[i];
            }
          }
          out.push(rec);
        }
        return out;
      }

      return [];
    };

    const rawItems = toRowObjects(records);
    console.log('[AnnexA] onRecords rows:', rawItems.length, 'keys:', rawItems[0] ? Object.keys(rawItems[0]) : []);

    const pick = (obj, keys) => {
      for (const k of keys) {
        if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
          return obj[k];
        }
      }
      return undefined;
    };

    const normalizeAsset = (rec) => {
      const assignedFromKnownKeys =
        pick(rec, ['Assigned date', 'Assigned Date', 'Assigned', 'AssignedDate', 'Assigned_Date']) ??
        pick(rec, ['Assigned On', 'Assigned on', 'AssignedOn']);

      // Fallback for Grist column-id vs label differences (e.g. Assigned_Date, assigned_date, etc).
      const assignedFromFuzzyKey = Object.keys(rec || {}).find(k =>
        /assigned/i.test(k) && /date|on/i.test(k)
      );

      const assigned =
        assignedFromKnownKeys ??
        (assignedFromFuzzyKey ? rec[assignedFromFuzzyKey] : undefined);
      return {
        // Keep the original record for debugging.
        _raw: rec,
        Designation: _normalizeCellValue(pick(rec, ['Designation', 'Employee', 'Full Name', 'Full name'])),
        'Asset Type': pick(rec, ['Asset Type', 'Asset type', 'AssetType', 'Type']),
        Description: pick(rec, ['Description', 'Item', 'Equipment', 'Asset', 'Device']),
        Brand: pick(rec, ['Brand', 'Make', 'Manufacturer']),
        Model: pick(rec, ['Model', 'Model No', 'ModelNo', 'Model Number', 'ModelNumber']),
        Serial: pick(rec, ['Serial', 'Serial No', 'SerialNo', 'Serial Number', 'SerialNumber']),
        Notes: pick(rec, ['Notes', 'Note', 'Remarks', 'Comment']),
        'Assigned Date': assigned,
        'Assigned date': assigned,
      };
    };

    const items = rawItems.map(normalizeAsset);

    // Best-effort: if you want a reliable employee name here, add a formula column
    // in ASSETS such as "Full Name" = $Designation.Full_Name (or similar) and make it visible.
    const first = items[0] || {};
    // In your setup, employee name is stored in ASSETS under the "Designation" column,
    // so prefer that first.
    const fullName = _normalizeCellValue(
      first.Designation ??
        first['Designation'] ??
        first['Full Name'] ??
        first['Full name'] ??
        first.FullName ??
        first.Employee ??
        ''
    );

    const row = {
      Items: items,
      'Full Name': fullName,
    };

    data.invoice = Object.assign({}, data.invoice || {}, row);
    window.invoice = row;
  } catch (err) {
    handleError(err);
  }
}

Vue.filter('currency', formatNumberAsUSD)
function formatNumberAsUSD(value) {
  if (typeof value !== "number") {
    return value || '—';      // falsy value would be shown as a dash.
  }
  value = Math.round(value * 100) / 100;    // Round to nearest cent.
  value = (value === -0 ? 0 : value);       // Avoid negative zero.

  const result = value.toLocaleString('en', {
    style: 'currency', currency: 'USD'
  })
  if (result.includes('NaN')) {
    return value;
  }
  return result;
}

Vue.filter('fallback', function(value, str) {
  if (!value) {
    throw new Error("Please provide column " + str);
  }
  return value;
});

Vue.filter('asDate', function(value) {
  if (typeof(value) === 'number') {
    value = new Date(value * 1000);
  }
  const date = moment.utc(value)
  return date.isValid() ? date.format('MMMM DD, YYYY') : value;
});

function tweakUrl(url) {
  if (!url) { return url; }
  if (url.toLowerCase().startsWith('http')) {
    return url;
  }
  return 'https://' + url;
};

function handleError(err) {
  console.error(err);
  const target = app || data;
  target.invoice = '';
  target.status = String(err).replace(/^Error: /, '');
  console.log(data);
}

function prepareList(lst, order) {
  if (order) {
    let orderedLst = [];
    const remaining = new Set(lst);
    for (const key of order) {
      if (remaining.has(key)) {
        remaining.delete(key);
        orderedLst.push(key);
      }
    }
    lst = [...orderedLst].concat([...remaining].sort());
  } else {
    lst = [...lst].sort();
  }
  return lst;
}

async function _fetchFirstAvailableTable(tableIds) {
  let lastErr = null;
  for (const tableId of tableIds) {
    try {
      return await grist.docApi.fetchTable(tableId);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not fetch any asset table.');
}

async function _getAssetTable() {
  if (_assetTableCache) { return _assetTableCache; }

  // If we don't have full document access, we can only read the selected table.
  // In that case, rely on the widget configuration (Select Data) and read it via fetchSelectedTable().
  if (_accessLevel && _accessLevel !== 'full') {
    try {
      const selected = await grist.docApi.fetchSelectedTable();
      _assetTableCache = _tableToRecordsById(selected);
      return _assetTableCache;
    } catch (e) {
      // Fall through to try other strategies (may still fail depending on access).
    }
  }

  if (_assetTableId === null) {
    try {
      const tables = await grist.docApi.listTables();
      const byRelevance = [...tables].sort((a, b) => {
        const al = (a.id || '').toLowerCase();
        const bl = (b.id || '').toLowerCase();
        const as = al === 'assets' || al === 'asset' ? 2 : (al.includes('asset') ? 1 : 0);
        const bs = bl === 'assets' || bl === 'asset' ? 2 : (bl.includes('asset') ? 1 : 0);
        return bs - as;
      });
      const best = byRelevance.find(t => (t.id || '').toLowerCase().includes('asset'));
      if (best && best.id) {
        _assetTableId = best.id;
      }
    } catch (e) {
      // We'll fall back to common names below.
    }
  }

  const table = _assetTableId
    ? await grist.docApi.fetchTable(_assetTableId)
    : await _fetchFirstAvailableTable(['ASSETS', 'Assets', 'Asset', 'assets', 'asset']);

  _assetTableCache = _tableToRecordsById(table);
  return _assetTableCache;
}

function _looksLikeRowIdList(value) {
  if (!Array.isArray(value)) { return false; }
  if (value.length === 0) { return false; }
  const v0 = value[0];
  return typeof v0 === 'number' || (typeof v0 === 'string' && /^\d+$/.test(v0));
}

function _normalizeCellValue(value) {
  // Handle common Grist cell shapes for References.
  if (value == null) { return null; }
  if (typeof value === 'number' || typeof value === 'string') { return value; }
  if (Array.isArray(value)) {
    // Common ref cell shapes are [id, display] in some contexts.
    if (value.length >= 1) { return value[0]; }
  }
  if (typeof value === 'object') {
    if ('id' in value) { return value.id; }
  }
  return String(value);
}

function _guessJoinValuesFromSelectedRow(row) {
  const candidates = [
    row.id,
    row.Designation,
    row['Designation'],
    row['Full Name'],
    row['Full name'],
    row.FullName,
    row.Full_Name,
  ];
  return candidates
    .map(_normalizeCellValue)
    .filter(v => v !== null && v !== undefined && v !== '');
}

function _buildItemsFromAssetsIfMissing(row, assetRecordsById) {
  if (!row || (Array.isArray(row.Items) && row.Items.length)) { return row; }

  const joinValues = _guessJoinValuesFromSelectedRow(row);
  if (joinValues.length === 0) { return row; }

  const assets = [];
  for (const rec of assetRecordsById.values()) {
    const recJoin = _normalizeCellValue(
      rec.Designation ?? rec['Designation'] ?? rec.Employee ?? rec['Employee'] ?? rec['Full Name']
    );
    if (recJoin == null) { continue; }
    if (joinValues.some(v => String(v) === String(recJoin))) {
      assets.push(rec);
    }
  }

  row.Items = assets;
  return row;
}

function _tableToRecordsById(table) {
  // Grist has returned a few shapes over time; support the common ones:
  // - Columnar: { id:[..], ColA:[..], ColB:[..] }
  // - Wrapped:  { columns: { id:[..], ColA:[..] } }
  // - Records:  { records: [{id, fields:{...}}, ...] } or [{id,...}, ...]
  if (!table) {
    throw new Error('Asset table fetch returned empty data.');
  }

  const recordById = new Map();

  // 1) Array-of-records shape.
  if (Array.isArray(table)) {
    for (const rec of table) {
      const rid = rec && (rec.id ?? rec.ID ?? rec.Id);
      if (rid == null) { continue; }
      recordById.set(rid, rec);
    }
    if (recordById.size > 0) { return recordById; }
  }

  // 2) {records:[...]} shape.
  if (Array.isArray(table.records)) {
    for (const r of table.records) {
      const rid = r && (r.id ?? r.ID ?? r.Id);
      if (rid == null) { continue; }
      const rec = r.fields ? Object.assign({id: rid}, r.fields) : r;
      recordById.set(rid, rec);
    }
    if (recordById.size > 0) { return recordById; }
  }

  // 3) Columnar shape (possibly wrapped in `.columns`).
  const cols = table.columns ? table.columns : table;
  const ids = cols.id || cols.ID || cols.Id;
  if (!Array.isArray(ids)) {
    const keys = Object.keys(table || {});
    const colKeys = (cols && cols !== table) ? Object.keys(cols) : [];
    throw new Error(
      'Asset table is missing an id column. ' +
      'Got keys: ' + JSON.stringify(keys.slice(0, 25)) +
      (colKeys.length ? ' and columns keys: ' + JSON.stringify(colKeys.slice(0, 25)) : '')
    );
  }

  for (let i = 0; i < ids.length; i++) {
    const rec = {id: ids[i]};
    for (const [colId, colVals] of Object.entries(cols)) {
      if (Array.isArray(colVals)) {
        rec[colId] = colVals[i];
      }
    }
    recordById.set(ids[i], rec);
  }
  return recordById;
}

async function _expandAssetItemsIfNeeded(row) {
  // If Items is a ReferenceList to an Asset table, Grist typically provides rowIds.
  // Expand rowIds into objects so the template can render Brand/Model/Serial/etc.
  if (!row || !_looksLikeRowIdList(row.Items)) { return row; }

  const assetRecordsById = await _getAssetTable();

  const expanded = [];
  for (const rawId of row.Items) {
    const id = typeof rawId === 'string' ? Number(rawId) : rawId;
    const rec = assetRecordsById.get(id);
    if (rec) { expanded.push(rec); }
  }
  row.Items = expanded;
  return row;
}

async function updateInvoice(row) {
  try {
    data.status = '';
    if (row === null) {
      throw new Error("(No data - not on row - please add or select a row)");
    }
    console.log("GOT...", JSON.stringify(row));
    if (row.References) {
      try {
        Object.assign(row, row.References);
      } catch (err) {
        throw new Error('Could not understand References column. ' + err);
      }
    }

    row = await _expandAssetItemsIfNeeded(row);
    // If there's no reference list column, build Items by filtering the Assets table.
    row = _buildItemsFromAssetsIfMissing(row, await _getAssetTable());

    // Add some guidance about columns.
    const want = new Set(Object.keys(addDemo({})));
    const accepted = new Set(['References']);
    const importance = ['Number', 'Client', 'Items', 'Total', 'Invoicer', 'Due', 
                        'Issued', 'Subtotal', 'Deduction', 'Taxes', 'Note', 'Paid'];
    if (!('Due' in row || 'Issued' in row)) {
      const seen = new Set(Object.keys(row).filter(k => k !== 'id' && k !== '_error_'));
      const help = row.Help = {};
      help.seen = prepareList(seen);
      const missing = [...want].filter(k => !seen.has(k));
      const ignoring = [...seen].filter(k => !want.has(k) && !accepted.has(k));
      const recognized = [...seen].filter(k => want.has(k) || accepted.has(k));
      if (missing.length > 0) {
        help.expected = prepareList(missing, importance);
      }
      if (ignoring.length > 0) {
        help.ignored = prepareList(ignoring);
      }
      if (recognized.length > 0) {
        help.recognized = prepareList(recognized);
      }
      if (!seen.has('References') && !(row.Issued || row.Due)) {
        row.SuggestReferencesColumn = true;
      }
    }
    addDemo(row);
    if (!row.Subtotal && !row.Total && row.Items && Array.isArray(row.Items)) {
      try {
        row.Subtotal = row.Items.reduce((a, b) => a + b.Price * b.Quantity, 0);
        row.Total = row.Subtotal + (row.Taxes || 0) - (row.Deduction || 0);
      } catch (e) {
        console.error(e);
      }
    }
    if (row.Invoicer && row.Invoicer.Website && !row.Invoicer.Url) {
      row.Invoicer.Url = tweakUrl(row.Invoicer.Website);
    }

    // Fiddle around with updating Vue (I'm not an expert).
    for (const key of want) {
      Vue.delete(data.invoice, key);
    }
    for (const key of ['Help', 'SuggestReferencesColumn', 'References']) {
      Vue.delete(data.invoice, key);
    }
    data.invoice = Object.assign({}, data.invoice, row);

    // Make invoice information available for debugging.
    window.invoice = row;
  } catch (err) {
    handleError(err);
  }
}

ready(function() {
  // Update the invoice anytime the document data changes.
  // Ask for read access by default; if you later switch widget access to "Full document access",
  // Grist will report it via onOptions and we'll automatically enable cross-table fetching.
  grist.ready({requiredAccess: 'read table'});

  // Track granted access level so we can fall back when needed.
  grist.onOptions(function(options, interaction) {
    if (interaction && interaction.access_level) {
      _accessLevel = interaction.access_level;
    }
  });

  // When Select Data = ASSETS and Select By = DESIGNATION, Grist will pass the
  // filtered ASSETS rows here. This works with "Read selected table" access.
  grist.onRecords(function(records) {
    if (_accessLevel && _accessLevel !== 'full') {
      _updateInvoiceFromAssetsRecords(records);
    }
  });

  grist.onRecord(row => {
    _lastSelectedRow = row;
    // Only in full-access mode do we fetch other tables (e.g. ASSETS) ourselves.
    // In read-table mode, rely on onRecords() with Select Data = ASSETS.
    if (_accessLevel === 'full') {
      updateInvoice(row).catch(handleError);
    }
  });

  // Monitor status so we can give user advice.
  grist.on('message', msg => {
    // If we are told about a table but not which row to access, check the
    // number of rows.  Currently if the table is empty, and "select by" is
    // not set, onRecord() will never be called.
    if (msg.tableId && !app.rowConnected) {
      grist.docApi.fetchSelectedTable().then(table => {
        if (table.id && table.id.length >= 1) {
          app.haveRows = true;
        }
      }).catch(e => console.log(e));
    }
    if (msg.tableId) { app.tableConnected = true; }
    if (msg.tableId && !msg.dataChange) { app.rowConnected = true; }

    // If any relevant table changes, refresh cached Assets and re-render.
    // Cross-table updates (e.g. editing ASSETS while connected to DESIGNATION)
    // won't trigger onRecord(), so we use dataChange messages.
    if (msg.dataChange && _accessLevel === 'full') {
      const changedTable = String(msg.tableId || '');
      const assetsTable = String(_assetTableId || '');
      const looksAssety = changedTable.toLowerCase().includes('asset');
      if (looksAssety || (assetsTable && changedTable === assetsTable)) {
        _assetTableCache = null;
        if (_lastSelectedRow) {
          updateInvoice(_lastSelectedRow).catch(handleError);
        }
      }
    }
  });

  Vue.config.errorHandler = function (err, vm, info)  {
    handleError(err);
  };

  app = new Vue({
    el: '#app',
    data: data
  });

  if (document.location.search.includes('demo')) {
    updateInvoice(exampleData);
  }
  if (document.location.search.includes('labels')) {
    updateInvoice({});
  }
});
