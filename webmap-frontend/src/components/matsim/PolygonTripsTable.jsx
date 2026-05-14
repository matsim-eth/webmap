import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';

const compareValues = (a, b) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

const renderCell = (value, isNumeric) => {
    if (value == null) return '';
    if (isNumeric && typeof value === 'number') return value.toLocaleString();
    return value;
};

const PolygonTripsTable = forwardRef(({ columns, rows, tableId = 'polygon-trips-table', loading = false }, ref) => {
    const [sortKey, setSortKey] = useState(null);
    const [sortDir, setSortDir] = useState('asc');

    const sortedRows = useMemo(() => {
        if (!sortKey) return rows;
        const dir = sortDir === 'asc' ? 1 : -1;
        return [...rows].sort((a, b) => compareValues(a[sortKey], b[sortKey]) * dir);
    }, [rows, sortKey, sortDir]);

    const handleSort = (key) => {
        if (sortKey === key) {
            setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortKey(key);
            setSortDir('asc');
        }
    };

    useImperativeHandle(ref, () => ({
        exportCsv: () => {
            if (!rows.length) return false;
            const header = columns.map((c) => `"${String(c.title).replace(/"/g, '""')}"`).join(',');
            const body = sortedRows.map((r) =>
                columns.map((c) => {
                    const v = r[c.key];
                    if (v == null) return '';
                    const s = String(v).replace(/"/g, '""');
                    return /[",\n]/.test(s) ? `"${s}"` : s;
                }).join(',')
            ).join('\n');
            const csv = `${header}\n${body}\n`;
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${tableId}_export.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            return true;
        },
    }), [columns, sortedRows, rows.length, tableId]);

    if (loading) {
        return (
            <div className="pt-table-state">
                <span>Preparing table…</span>
            </div>
        );
    }

    if (!rows.length) {
        return (
            <div className="pt-table-state pt-table-state--empty">
                <span>No data available</span>
            </div>
        );
    }

    return (
        <div className="pt-table-wrapper">
            <table className="pt-table" id={tableId}>
                <thead>
                    <tr>
                        {columns.map((c) => {
                            const isActive = sortKey === c.key;
                            const sortClass = isActive
                                ? (sortDir === 'asc' ? 'pt-sort pt-sort-asc' : 'pt-sort pt-sort-desc')
                                : 'pt-sort';
                            return (
                                <th
                                    key={c.key}
                                    className={sortClass}
                                    onClick={() => handleSort(c.key)}
                                    title="Click to sort"
                                >
                                    <span className="pt-th-label">{c.title}</span>
                                    <span className="pt-sort-arrow" aria-hidden="true" />
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sortedRows.map((row, i) => (
                        <tr key={row.rowKey ?? i} className={i % 2 === 1 ? 'pt-odd' : 'pt-even'}>
                            {columns.map((c) => (
                                <td key={c.key} className={c.numeric ? 'pt-cell-num' : 'pt-cell-text'}>
                                    {renderCell(row[c.key], c.numeric)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
});

export default PolygonTripsTable;
