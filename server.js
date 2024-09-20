import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate status input
 * @param {any} status
 */
const validateStatus = (status) => {
  const allowedStatuses = ['backlog', 'in-progress', 'complete'];
  if (!allowedStatuses.includes(status)) {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      },
    };
  }

  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority) || priority <= 0 || !Number.isInteger(priority)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  // Retrieve & validate id
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) { return res.status(400).send(messageObj); }

  // Retrieve status & priority
  let { status, priority } = req.body;

  // Validate status
  if (status) {
    const { valid, messageObj } = validateStatus(status);
    if (!valid) { return res.status(400).send(messageObj); }
  }

  // Validate priority
  if (priority) {
    const { valid, messageObj } = validatePriority(priority);
    if (!valid) { return res.status(400).send(messageObj); }
  }
  
  // Fetch client data from db
  let clients = db.prepare('select * from clients').all();
  const client = clients.find(client => client.id === id);

  // Save old status and priority
  const oldStatus = client.status;
  const oldPriority = client.priority;

  // Case 1: Old status & priority both same as current -> Do nothing
  if (oldStatus === status && oldPriority === priority) {
    return res.status(200).send(clients);
  }

  // Case 2: Same status but diff priority -> Reorder in same swimlane
  if (oldStatus === status && oldPriority !== priority) {
    client.priority = priority - 0.5;  // Temp priority to recalculate

    // Reorder by changing priority values for all affected clients after current client
    const sameStatusClients = clients.filter(client => client.status === status)
      .sort((a, b) => a.priority - b.priority)
      .map((client, idx) => ({
        ...client,
        priority: idx + 1,
      }));
    const diffStatusClients = clients.filter(client => client.status !== status);

    // Reconstruct clients array
    clients = [...diffStatusClients, ...sameStatusClients,];
  }

  // Case 3: Same priority but diff status -> Move to new swimlane
  else if (oldStatus !== status) {
    // Update to new status, Set temp priority
    client.status = status;
    client.priority = priority ? priority - 0.5 : Number.MAX_SAFE_INTEGER;

    // Reorder clients in old swimlane
    const oldStatusClients = clients.filter(client => client.status === oldStatus)
      .sort((a, b) => a.priority - b.priority)
      .map((client, idx) => ({
        ...client,
        priority: idx + 1,
      }));
    
    // Reorder clients in new swimlane
    const newStatusClients = clients.filter(client => client.status === status)
      .sort((a, b) => a.priority - b.priority)
      .map((client, idx) => ({
        ...client,
        priority: idx + 1,
      }));
    
      // Ensure moved client have new priority at end of new swimlane
      client.priority = newStatusClients.length;

      // Reconstruct clients array
      const otherStatusClients = clients.filter(client => client.status !== status && client.status !== oldStatus);
      clients = [...otherStatusClients, ...oldStatusClients, ...newStatusClients];
  }

  // Update database with new data
  const updateStatement = db.prepare('UPDATE clients SET status = ?, priority = ? WHERE id = ?');
  clients.forEach(client => {
    updateStatement.run(client.status, client.priority, client.id);
  });

  return res.status(200).send(clients);
});


const server = app.listen(3001, () => {
  console.log("App running on port 3001");
});

// Gracefully handle shutdown
const gracefulShutdown = () => {
  console.log('Received shutdown signal. Closing server gracefully...');
  
  // Stop the server from accepting new connections
  server.close((err) => {
    if (err) {
      console.error('Error occurred while closing server:', err);
      process.exit(1); // Exit with error
    }

    // Close database connection
    console.log('Closing database connection...');
    db.close();

    console.log('Server closed successfully. Exiting...');
    process.exit(0); // Exit without error
  });

  // Forcefully exit after a timeout (to avoid hanging indefinitely)
  setTimeout(() => {
    console.error('Server shutdown took too long. Forcing exit.');
    process.exit(1); // Exit with error
  }, 10000); // 10-second timeout for forced exit
};

process.on('SIGTERM', gracefulShutdown); // For system shutdown
process.on('SIGINT', gracefulShutdown);  // For Ctrl+C (manual stop)
