import swaggerJSDoc from 'swagger-jsdoc';
import path from 'path';
import { fileURLToPath } from 'url';
import { ACTIONS, SCOPES, RESOURCE_KEYS } from '../utils/permissions.js';

const dirName = path.dirname(fileURLToPath(import.meta.url));

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'B Ledger API',
    version: process.env.API_VERSION || '1.0.0',
    description: [
      'Backend REST API for B Ledger.',
      '',
      '### Authorization',
      'Every protected route declares a permission as `resource:action`.',
      "A user's effective permissions are their **role**'s grid, adjusted by any",
      'personal **overrides** (deny always wins). Users whose role has',
      '`fullAccess` (Admin) bypass the grid entirely.',
      '',
      'Resources marked *scopable* also carry a scope: `all` sees every row,',
      "`own` sees only rows belonging to the user's `assignedBusinesses`."
    ].join('\n')
  },
  servers: [
    {
      url: `${process.env.SERVER_URI || 'http://localhost:5000'}/api/v1`,
      description: 'API Server'
    }
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
    },
    schemas: {
      Permission: {
        type: 'object',
        description: "One row of a role's checkbox grid.",
        properties: {
          resource: { type: 'string', enum: RESOURCE_KEYS, example: 'businesses' },
          actions: {
            type: 'array',
            items: { type: 'string', enum: ACTIONS },
            example: ['read', 'create']
          },
          scope: {
            type: 'string',
            enum: SCOPES,
            default: 'own',
            description: 'Ignored for resources that are not scopable'
          }
        }
      },
      PermissionOverride: {
        type: 'object',
        description: 'Per-user delta on top of the role. Deny beats grant.',
        properties: {
          resource: { type: 'string', enum: RESOURCE_KEYS },
          actions: { type: 'array', items: { type: 'string', enum: ACTIONS } },
          effect: { type: 'string', enum: ['grant', 'deny'] },
          scope: { type: 'string', enum: SCOPES }
        }
      },
      Role: {
        type: 'object',
        required: ['name'],
        properties: {
          _id: { type: 'string', example: '5d8a234a62935d3c5c402e38' },
          name: { type: 'string', example: 'Dispatcher' },
          description: { type: 'string', example: 'Handles dispatch for assigned businesses' },
          permissions: { type: 'array', items: { $ref: '#/components/schemas/Permission' } },
          fullAccess: {
            type: 'boolean',
            readOnly: true,
            description: 'Bypasses the permission grid. Seeder-only; Admin role only.'
          },
          isSystem: {
            type: 'boolean',
            readOnly: true,
            description: 'System roles cannot be edited or deleted'
          },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      User: {
        type: 'object',
        required: ['name', 'email', 'phone', 'role'],
        properties: {
          _id: { type: 'string', example: '5d8a234a62935d3c5c402e38' },
          name: { type: 'string', example: 'Ali Raza' },
          email: { type: 'string', format: 'email', example: 'ali@b-ledger.pk' },
          phone: { type: 'string', example: '+923001234567' },
          role: { type: 'string', description: 'Role ObjectId (populated on read)' },
          permissionOverrides: {
            type: 'array',
            items: { $ref: '#/components/schemas/PermissionOverride' }
          },
          assignedBusinesses: {
            type: 'array',
            items: { type: 'string' },
            description: 'Business ObjectIds — drives scope "own"'
          },
          status: { type: 'string', enum: ['active', 'inactive'], example: 'active' },
          mustChangePassword: { type: 'boolean', readOnly: true },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Category: {
        type: 'object',
        required: ['name'],
        properties: {
          _id: { type: 'string', example: '5d8a234a62935d3c5c402e40' },
          name: { type: 'string', example: 'Clothing' },
          description: { type: 'string', example: 'Apparel and fashion' },
          variantOptions: {
            type: 'array',
            description:
              'Master menu of variant labels a product in this category may stock. Normalised server-side (trimmed, deduped case-insensitively, order preserved).',
            items: { type: 'string' },
            example: ['Unstitched', 'S', 'M', 'L', 'XL']
          },
          status: { type: 'string', enum: ['active', 'inactive'] },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Business: {
        type: 'object',
        required: ['name', 'category'],
        properties: {
          _id: { type: 'string', example: '5d8a234a62935d3c5c402e39' },
          name: { type: 'string', example: 'Acme Clothing' },
          category: {
            type: 'string',
            description: 'Category ObjectId. Populated to a Category object on read.',
            example: '5d8a234a62935d3c5c402e40'
          },
          storeLink: { type: 'string', example: 'https://acme-clothing.myshopify.com' },
          facebookLink: { type: 'string', example: 'https://facebook.com/acmeclothing' },
          instagramLink: { type: 'string', example: 'https://instagram.com/acmeclothing' },
          whatsappNumber: { type: 'string', example: '+923001234567' },
          status: { type: 'string', enum: ['active', 'inactive'] },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Variant: {
        type: 'object',
        required: ['costPrice', 'salePrice'],
        description: 'One sellable SKU — a named line with cost, sale, stock and barcode.',
        properties: {
          _id: { type: 'string', readOnly: true },
          label: {
            type: 'string',
            description:
              'Free-text variant name, e.g. "Unstitched", "M". "Default" for single-form products.',
            example: 'M'
          },
          costPrice: { type: 'number', example: 1000 },
          salePrice: { type: 'number', example: 1600 },
          stock: { type: 'integer', example: 1 },
          barcode: {
            type: 'string',
            readOnly: true,
            description: 'Auto-generated, globally unique per SKU',
            example: '245018337201'
          }
        }
      },
      Product: {
        type: 'object',
        required: ['business', 'name', 'variants'],
        properties: {
          _id: { type: 'string', example: '5d8a234a62935d3c5c402e60' },
          business: { type: 'string', description: 'Business ObjectId (populated on read)' },
          category: {
            type: 'string',
            readOnly: true,
            description: "Derived from the business's category; not settable by the client"
          },
          name: { type: 'string', example: 'Embroidered Lawn Suit' },
          articleNumber: {
            type: 'string',
            readOnly: true,
            description: 'Auto-generated 4-char code for search',
            example: 'A4K9'
          },
          lowStockThreshold: { type: 'integer', example: 5 },
          variants: { type: 'array', items: { $ref: '#/components/schemas/Variant' } },
          totalStock: {
            type: 'integer',
            readOnly: true,
            description: 'Sum of variant stock (derived)'
          },
          status: { type: 'string', enum: ['active', 'inactive'] },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Customer: {
        type: 'object',
        required: ['name', 'phone'],
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          name: { type: 'string', example: 'Sana' },
          phone: { type: 'string', example: '+923001234567' },
          city: { type: 'string', example: 'Lahore' },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      OrderItem: {
        type: 'object',
        required: ['product', 'variantId', 'quantity', 'unitPrice'],
        properties: {
          product: { type: 'string', description: 'Product ObjectId' },
          variantId: { type: 'string', description: 'The SKU (embedded variant _id)' },
          productName: { type: 'string', readOnly: true, description: 'Snapshot' },
          variantLabel: { type: 'string', readOnly: true, description: 'Snapshot, e.g. "M"' },
          quantity: { type: 'integer', example: 2 },
          unitPrice: { type: 'number', example: 2500, description: 'Negotiated' },
          unitCost: {
            type: 'number',
            readOnly: true,
            description: 'Snapshot of cost at order time'
          }
        }
      },
      Order: {
        type: 'object',
        required: ['business', 'customerName', 'contactNumber', 'items'],
        properties: {
          _id: { type: 'string' },
          orderNumber: { type: 'string', readOnly: true, example: '0007' },
          business: { type: 'string' },
          customer: { type: 'string', readOnly: true, description: 'Upserted by phone' },
          courier: {
            type: 'string',
            description: 'A courier-type Party of the business. Required.'
          },
          customerName: { type: 'string', example: 'Sana' },
          contactNumber: { type: 'string', example: '+923001234567' },
          city: { type: 'string', example: 'Lahore' },
          deliveryAddress: { type: 'string' },
          items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
          subtotal: { type: 'number', readOnly: true },
          advanceAmount: { type: 'number', example: 500, description: 'Prepaid deposit' },
          total: { type: 'number', readOnly: true },
          codAmount: {
            type: 'number',
            readOnly: true,
            description: 'total − advance (courier collects)'
          },
          status: {
            type: 'string',
            enum: ['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled', 'returned'],
            description: 'Fulfillment axis'
          },
          paymentStatus: {
            type: 'string',
            enum: ['unpaid', 'paid'],
            description: 'Payment axis — independent of fulfillment'
          },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Account: {
        type: 'object',
        required: ['business', 'code', 'name', 'type'],
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          code: { type: 'string', example: '1000' },
          name: { type: 'string', example: 'Cash' },
          type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
          normalBalance: { type: 'string', enum: ['debit', 'credit'], readOnly: true },
          isControl: { type: 'boolean', description: 'Detail lives in a party ledger (AR/AP)' },
          isSystem: { type: 'boolean' },
          isActive: { type: 'boolean' }
        }
      },
      Party: {
        type: 'object',
        required: ['business', 'name', 'type'],
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          name: { type: 'string', example: 'Master Tailor' },
          type: { type: 'string', enum: ['supplier', 'reseller', 'employee', 'courier'] },
          phone: { type: 'string' },
          accountId: {
            type: 'string',
            description: 'Merchant/account id — mainly a courier account number'
          },
          note: { type: 'string' },
          isActive: { type: 'boolean' },
          balance: {
            type: 'number',
            readOnly: true,
            description: 'Derived — positive: they owe you; negative: you owe them'
          }
        }
      },
      JournalLine: {
        type: 'object',
        description: 'One posting line — a debit OR a credit, never both',
        properties: {
          account: { type: 'string' },
          party: { type: 'string' },
          product: { type: 'string' },
          batch: { type: 'string' },
          courier: { type: 'string' },
          debitPaisa: { type: 'integer', description: 'Amount in paisa (1 rupee = 100)' },
          creditPaisa: { type: 'integer', description: 'Amount in paisa' }
        }
      },
      JournalEntry: {
        type: 'object',
        required: ['business', 'lines'],
        description: 'Balanced double-entry atom — total debits equal total credits',
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          date: { type: 'string', format: 'date-time' },
          memo: { type: 'string' },
          source: {
            type: 'object',
            properties: { kind: { type: 'string' }, ref: { type: 'string' } }
          },
          lines: { type: 'array', items: { $ref: '#/components/schemas/JournalLine' } },
          reversalOf: { type: 'string', description: 'Set when this entry reverses another' }
        }
      },
      ProductionBatch: {
        type: 'object',
        required: ['business', 'product', 'variantId', 'quantity'],
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          product: { type: 'string' },
          variantId: { type: 'string' },
          variantLabel: { type: 'string' },
          quantity: { type: 'integer', example: 20 },
          costLines: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', example: 'Tailoring' },
                amountPaisa: { type: 'integer' },
                party: { type: 'string' }
              }
            }
          },
          status: { type: 'string', enum: ['open', 'closed'] },
          unitCostPaisa: { type: 'integer', readOnly: true },
          totalCostPaisa: { type: 'integer', readOnly: true }
        }
      },
      Consignment: {
        type: 'object',
        required: ['business', 'party', 'lines'],
        properties: {
          _id: { type: 'string' },
          consignmentNumber: { type: 'string', readOnly: true },
          business: { type: 'string' },
          party: { type: 'string', description: 'Reseller party id' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['product', 'variantId', 'quantity', 'unitPrice'],
              properties: {
                _id: { type: 'string', readOnly: true },
                product: { type: 'string' },
                variantId: { type: 'string' },
                variantLabel: { type: 'string' },
                quantityIssued: { type: 'integer' },
                quantityReturned: { type: 'integer', readOnly: true },
                quantitySold: { type: 'integer', readOnly: true },
                remaining: { type: 'integer', readOnly: true },
                unitCostPaisa: { type: 'integer', readOnly: true },
                unitPricePaisa: { type: 'integer' }
              }
            }
          },
          lineCount: { type: 'integer', readOnly: true },
          unitsRemaining: { type: 'integer', readOnly: true },
          status: { type: 'string', enum: ['out', 'settled'], readOnly: true }
        }
      },
      PeriodLock: {
        type: 'object',
        required: ['business', 'periodEnd'],
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          periodEnd: {
            type: 'string',
            format: 'date-time',
            description: 'Entries dated on or before this are frozen'
          }
        }
      },
      Notification: {
        type: 'object',
        required: ['business', 'type', 'title'],
        properties: {
          _id: { type: 'string' },
          business: { type: 'string' },
          type: { type: 'string', enum: ['new-order', 'order-paid', 'low-stock'] },
          title: { type: 'string' },
          body: { type: 'string' },
          link: { type: 'string', description: 'Client route to open, e.g. /orders' },
          isRead: { type: 'boolean', readOnly: true, description: 'Per-user read state' },
          createdAt: { type: 'string', format: 'date-time' }
        }
      },
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: { type: 'string', example: 'You do not have permission to read businesses' }
        }
      }
    },
    responses: {
      Unauthorized: {
        description: 'Missing, invalid or expired token',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
      },
      Forbidden: {
        description: 'Authenticated but lacking the required permission',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
      }
    }
  },
  security: [{ bearerAuth: [] }]
};

export default swaggerJSDoc({
  swaggerDefinition,
  // Forward slashes only — swagger-jsdoc's glob treats a backslash as an escape
  // char, so a Windows `path.join` result (D:\…\routes\*.js) matches nothing and
  // no paths are generated (only the inline schemas show). Normalise separators.
  apis: [path.join(dirName, '../routes/*.js').replace(/\\/g, '/')]
});
