import React from "react";
import "./Table.css";

const TransitStopAttributesTable = ({ properties }) => {
  if (!properties) return null;

  const { name, stop_id, lines } = properties;
  const numRoutes = lines?.length || 0;

  return (
    <div className="canton-mode-share">
      <h4>Stop Info</h4>
      <table>
        <tbody>
          <tr><td>Name</td><td>{name}</td></tr>
          <tr><td>Stop ID</td><td>{stop_id}</td></tr>
          <tr><td>Routes</td><td>{numRoutes}</td></tr>
          <tr><td>Lines</td>
            <td>
              <ul>
                {lines.map((line, idx) => (
                  <li key={idx}>{line.line_id} ({line.mode})</li>
                ))}
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

export default TransitStopAttributesTable;
