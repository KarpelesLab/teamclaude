// Each caller receives independent synthetic accounts.
export const affinityAccounts = () => ['a', 'b', 'c'].map(id =>
  ({ id, name: id, type: 'apikey', apiKey: `synthetic-${id}` }));
