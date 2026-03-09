import React from 'react';

const PtSubscriptionInfo = () => {
  const subscriptionTypes = [
    {
      name: "Verbundabo (Regional Pass)",
      description: "Unlimited travel within a specific regional transport network (e.g., ZVV for Zürich region)."
    },
    {
      name: "Halbtax (Half-Fare Card)",
      description: "50% discount on most public transport tickets in Switzerland."
    },
    {
      name: "Strecke (Point-to-point Travelcard)",
      description: "Unlimited travel on a specific route (e.g., Zurich to Bern)."
    },
    {
      name: "Gleis 7 (Night GA)",
      description: "Special subscription for young people aged 7-25, offering unlimited travel after 7 PM."
    },
    {
      name: "Junior Card",
      description: "Free travel for children aged 6-16 when accompanied by a parent with a valid ticket or travelcard."
    },
    {
      name: "GA (General Abonnement)",
      description: "Unlimited travel on nearly all public transport throughout Switzerland, including trains, buses, boats, and most mountain railways."
    },
  ];

  return (
    <div className="plot-wrapper" style={{ padding: '8px', overflowY: 'auto' }}>
      <h4 className="plot-title" style={{ marginBottom: '12px', fontSize: '14px' }}>Swiss PT Subscription Types</h4>
      <div style={{ fontSize: '11px', lineHeight: '1.5' }}>
        {subscriptionTypes.map((sub, index) => (
          <div key={index} style={{ marginBottom: '12px' }}>
            <div style={{ fontWeight: 'bold', color: '#374151', marginBottom: '3px' }}>
              {sub.name}
            </div>
            <div style={{ color: '#6b7280' }}>
              {sub.description}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PtSubscriptionInfo;
