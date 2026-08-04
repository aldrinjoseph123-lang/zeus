-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CUSTOMER', 'PARTNER', 'VENDOR', 'PROSPECT');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'WORKING', 'NURTURING', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "DealType" AS ENUM ('PRODUCT', 'SERVICE', 'MIXED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RegistrationSide" AS ENUM ('VENDOR', 'PARTNER');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRING', 'RENEWED', 'LAPSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('TAX_INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "PoDirection" AS ENUM ('CUSTOMER', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('TASK', 'CALL', 'MEETING', 'EMAIL', 'NOTE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "entraOid" TEXT,
    "jobTitle" TEXT,
    "phone" TEXT,
    "whatsappNumber" TEXT,
    "avatarColor" TEXT NOT NULL DEFAULT '#e11d2e',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "roleId" TEXT NOT NULL,
    "teamId" TEXT,
    "managerId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'product',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL DEFAULT 'PROSPECT',
    "domain" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "employeeBand" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "trn" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "emirate" TEXT,
    "country" TEXT NOT NULL DEFAULT 'United Arab Emirates',
    "poBox" TEXT,
    "linkedinUrl" TEXT,
    "description" TEXT,
    "ownerId" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "mobile" TEXT,
    "jobTitle" TEXT,
    "department" TEXT,
    "linkedinUrl" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "accountId" TEXT,
    "ownerId" TEXT,
    "description" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "domain" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "jobTitle" TEXT,
    "linkedinUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Database',
    "sourcePartnerId" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "rating" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "interestArea" TEXT,
    "estimatedValue" DECIMAL(14,2),
    "description" TEXT,
    "ownerId" TEXT,
    "emirate" TEXT,
    "country" TEXT NOT NULL DEFAULT 'United Arab Emirates',
    "convertedAt" TIMESTAMP(3),
    "convertedAccountId" TEXT,
    "convertedContactId" TEXT,
    "convertedDealId" TEXT,
    "disqualifyReason" TEXT,
    "lastActivityAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'product',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "isLost" BOOLEAN NOT NULL DEFAULT false,
    "color" TEXT NOT NULL DEFAULT '#6b6b6b',
    "rotDays" INTEGER NOT NULL DEFAULT 14,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "partnerAccountId" TEXT,
    "primaryContactId" TEXT,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "type" "DealType" NOT NULL DEFAULT 'PRODUCT',
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "vatAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "probability" INTEGER NOT NULL DEFAULT 0,
    "closeDate" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'Database',
    "sourcePartnerId" TEXT,
    "lostReason" TEXT,
    "competitor" TEXT,
    "nextStep" TEXT,
    "description" TEXT,
    "ownerId" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvalRequestedAt" TIMESTAMP(3),
    "approvalRequestedById" TEXT,
    "approvalDecidedAt" TIMESTAMP(3),
    "approvalDecidedById" TEXT,
    "approvalNote" TEXT,
    "stageChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3),
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageHistory" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "fromStageId" TEXT,
    "toStageId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "changedById" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "daysInStage" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealRegistration" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "side" "RegistrationSide" NOT NULL DEFAULT 'VENDOR',
    "vendorId" TEXT,
    "partnerId" TEXT,
    "partnerContactId" TEXT,
    "partnerNotifiedAt" TIMESTAMP(3),
    "regNumber" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "approvedDiscount" DECIMAL(5,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DealRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "vendorId" TEXT,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'licence',
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "termValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "termCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "termMonths" INTEGER NOT NULL DEFAULT 12,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceInvoiceId" TEXT,
    "sourceDealId" TEXT,
    "renewalDealId" TEXT,
    "renewedFromId" TEXT,
    "vendorRef" TEXT,
    "notes" TEXT,
    "cancelReason" TEXT,
    "renewalOpenedAt" TIMESTAMP(3),
    "lastRemindedDays" INTEGER,
    "ownerId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProductType" NOT NULL DEFAULT 'PRODUCT',
    "category" TEXT,
    "vendorId" TEXT,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'licence',
    "listPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "dealId" TEXT,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "vatAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "marginAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "terms" TEXT,
    "notes" TEXT,
    "preparedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteLine" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "productId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'licence',
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "termMonths" INTEGER,

    CONSTRAINT "QuoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" "InvoiceType" NOT NULL DEFAULT 'TAX_INVOICE',
    "quoteId" TEXT,
    "dealId" TEXT,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "customerPoId" TEXT,
    "originalInvoiceId" TEXT,
    "creditReason" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvalRequestedAt" TIMESTAMP(3),
    "approvalRequestedById" TEXT,
    "approvalDecidedAt" TIMESTAMP(3),
    "approvalDecidedById" TEXT,
    "approvalNote" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplyDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "exchangeRate" DECIMAL(14,6),
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "vatAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "supplierName" TEXT,
    "supplierTrn" TEXT,
    "supplierAddress" TEXT,
    "recipientName" TEXT,
    "recipientTrn" TEXT,
    "recipientAddress" TEXT,
    "placeOfSupply" TEXT,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "poNumber" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "productId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'licence',
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineVat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "termMonths" INTEGER,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "direction" "PoDirection" NOT NULL,
    "status" "PoStatus" NOT NULL DEFAULT 'DRAFT',
    "accountId" TEXT NOT NULL,
    "contactId" TEXT,
    "dealId" TEXT,
    "quoteId" TEXT,
    "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDate" TIMESTAMP(3),
    "paymentTermsDays" INTEGER,
    "paymentDueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discountAmt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "vatAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "supplierInvoiceNumber" TEXT,
    "supplierInvoiceDate" TIMESTAMP(3),
    "shipToAddress" TEXT,
    "terms" TEXT,
    "notes" TEXT,
    "issuedAt" TIMESTAMP(3),
    "ownerId" TEXT,
    "createdById" TEXT,
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvalRequestedAt" TIMESTAMP(3),
    "approvalRequestedById" TEXT,
    "approvalDecidedAt" TIMESTAMP(3),
    "approvalDecidedById" TEXT,
    "approvalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "productId" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL DEFAULT 1,
    "quantityReceived" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'licence',
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "lineTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineVat" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "direction" "PaymentDirection" NOT NULL,
    "reference" TEXT,
    "method" TEXT NOT NULL DEFAULT 'Bank Transfer',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "accountId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "purchaseOrderId" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL DEFAULT 'TASK',
    "subject" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "priority" TEXT NOT NULL DEFAULT 'Normal',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMin" INTEGER,
    "outcome" TEXT,
    "ownerId" TEXT,
    "createdById" TEXT,
    "accountId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "dealId" TEXT,
    "remindedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT,
    "accountId" TEXT,
    "contactId" TEXT,
    "leadId" TEXT,
    "dealId" TEXT,
    "purchaseOrderId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT,
    "changes" JSONB,
    "undo" JSONB,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationRule" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "teams" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp" BOOLEAN NOT NULL DEFAULT false,
    "thresholdDays" INTEGER,
    "audience" TEXT NOT NULL DEFAULT 'owner',
    "recipientIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "teamsWebhookId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamsWebhook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamsWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Target" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "year" INTEGER NOT NULL,
    "quarter" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AED',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomField" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'text',
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CustomField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "label" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isConnected" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secrets" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "destination" TEXT NOT NULL DEFAULT 'onedrive',
    "filename" TEXT,
    "sizeBytes" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Counter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_entraOid_key" ON "User"("entraOid");

-- CreateIndex
CREATE INDEX "User_teamId_idx" ON "User"("teamId");

-- CreateIndex
CREATE INDEX "User_roleId_idx" ON "User"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE INDEX "Account_domain_idx" ON "Account"("domain");

-- CreateIndex
CREATE INDEX "Account_type_idx" ON "Account"("type");

-- CreateIndex
CREATE INDEX "Account_ownerId_idx" ON "Account"("ownerId");

-- CreateIndex
CREATE INDEX "Account_lastActivityAt_idx" ON "Account"("lastActivityAt");

-- CreateIndex
CREATE INDEX "Contact_email_idx" ON "Contact"("email");

-- CreateIndex
CREATE INDEX "Contact_accountId_idx" ON "Contact"("accountId");

-- CreateIndex
CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");

-- CreateIndex
CREATE INDEX "Lead_domain_idx" ON "Lead"("domain");

-- CreateIndex
CREATE INDEX "Lead_status_idx" ON "Lead"("status");

-- CreateIndex
CREATE INDEX "Lead_ownerId_idx" ON "Lead"("ownerId");

-- CreateIndex
CREATE INDEX "Lead_email_idx" ON "Lead"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_name_key" ON "Pipeline"("name");

-- CreateIndex
CREATE INDEX "Stage_pipelineId_order_idx" ON "Stage"("pipelineId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_pipelineId_name_key" ON "Stage"("pipelineId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_reference_key" ON "Deal"("reference");

-- CreateIndex
CREATE INDEX "Deal_accountId_idx" ON "Deal"("accountId");

-- CreateIndex
CREATE INDEX "Deal_partnerAccountId_idx" ON "Deal"("partnerAccountId");

-- CreateIndex
CREATE INDEX "Deal_stageId_idx" ON "Deal"("stageId");

-- CreateIndex
CREATE INDEX "Deal_status_idx" ON "Deal"("status");

-- CreateIndex
CREATE INDEX "Deal_ownerId_idx" ON "Deal"("ownerId");

-- CreateIndex
CREATE INDEX "Deal_closeDate_idx" ON "Deal"("closeDate");

-- CreateIndex
CREATE INDEX "Deal_approvalStatus_idx" ON "Deal"("approvalStatus");

-- CreateIndex
CREATE INDEX "StageHistory_dealId_idx" ON "StageHistory"("dealId");

-- CreateIndex
CREATE INDEX "StageHistory_changedAt_idx" ON "StageHistory"("changedAt");

-- CreateIndex
CREATE INDEX "DealRegistration_dealId_idx" ON "DealRegistration"("dealId");

-- CreateIndex
CREATE INDEX "DealRegistration_vendorId_idx" ON "DealRegistration"("vendorId");

-- CreateIndex
CREATE INDEX "DealRegistration_partnerId_idx" ON "DealRegistration"("partnerId");

-- CreateIndex
CREATE INDEX "DealRegistration_expiresAt_idx" ON "DealRegistration"("expiresAt");

-- CreateIndex
CREATE INDEX "DealRegistration_side_status_idx" ON "DealRegistration"("side", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_reference_key" ON "Subscription"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_renewedFromId_key" ON "Subscription"("renewedFromId");

-- CreateIndex
CREATE INDEX "Subscription_accountId_idx" ON "Subscription"("accountId");

-- CreateIndex
CREATE INDEX "Subscription_endDate_idx" ON "Subscription"("endDate");

-- CreateIndex
CREATE INDEX "Subscription_status_endDate_idx" ON "Subscription"("status", "endDate");

-- CreateIndex
CREATE INDEX "Subscription_ownerId_idx" ON "Subscription"("ownerId");

-- CreateIndex
CREATE INDEX "Subscription_vendorId_idx" ON "Subscription"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_vendorId_idx" ON "Product"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_number_key" ON "Quote"("number");

-- CreateIndex
CREATE INDEX "Quote_accountId_idx" ON "Quote"("accountId");

-- CreateIndex
CREATE INDEX "Quote_dealId_idx" ON "Quote"("dealId");

-- CreateIndex
CREATE INDEX "Quote_status_idx" ON "Quote"("status");

-- CreateIndex
CREATE INDEX "QuoteLine_quoteId_idx" ON "QuoteLine"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_accountId_idx" ON "Invoice"("accountId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE INDEX "Invoice_type_idx" ON "Invoice"("type");

-- CreateIndex
CREATE INDEX "Invoice_originalInvoiceId_idx" ON "Invoice"("originalInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_approvalStatus_idx" ON "Invoice"("approvalStatus");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_accountId_idx" ON "PurchaseOrder"("accountId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_direction_status_idx" ON "PurchaseOrder"("direction", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_paymentDueDate_idx" ON "PurchaseOrder"("paymentDueDate");

-- CreateIndex
CREATE INDEX "PurchaseOrder_dealId_idx" ON "PurchaseOrder"("dealId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_approvalStatus_idx" ON "PurchaseOrder"("approvalStatus");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_direction_number_key" ON "PurchaseOrder"("direction", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx" ON "PurchaseOrderLine"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "Payment_direction_paidAt_idx" ON "Payment"("direction", "paidAt");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_purchaseOrderId_idx" ON "Payment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "Payment_accountId_idx" ON "Payment"("accountId");

-- CreateIndex
CREATE INDEX "Activity_ownerId_status_idx" ON "Activity"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Activity_dueAt_idx" ON "Activity"("dueAt");

-- CreateIndex
CREATE INDEX "Activity_dealId_idx" ON "Activity"("dealId");

-- CreateIndex
CREATE INDEX "Activity_accountId_idx" ON "Activity"("accountId");

-- CreateIndex
CREATE INDEX "Activity_leadId_idx" ON "Activity"("leadId");

-- CreateIndex
CREATE INDEX "Attachment_dealId_idx" ON "Attachment"("dealId");

-- CreateIndex
CREATE INDEX "Attachment_accountId_idx" ON "Attachment"("accountId");

-- CreateIndex
CREATE INDEX "Attachment_purchaseOrderId_idx" ON "Attachment"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_userId_undoneAt_idx" ON "AuditLog"("userId", "undoneAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRule_event_key" ON "NotificationRule"("event");

-- CreateIndex
CREATE UNIQUE INDEX "TeamsWebhook_name_key" ON "TeamsWebhook"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Target_userId_year_quarter_key" ON "Target"("userId", "year", "quarter");

-- CreateIndex
CREATE UNIQUE INDEX "CustomField_module_key_key" ON "CustomField"("module", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_provider_key" ON "Integration"("provider");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_convertedAccountId_fkey" FOREIGN KEY ("convertedAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_partnerAccountId_fkey" FOREIGN KEY ("partnerAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "Stage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_approvalRequestedById_fkey" FOREIGN KEY ("approvalRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_approvalDecidedById_fkey" FOREIGN KEY ("approvalDecidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRegistration" ADD CONSTRAINT "DealRegistration_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRegistration" ADD CONSTRAINT "DealRegistration_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRegistration" ADD CONSTRAINT "DealRegistration_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealRegistration" ADD CONSTRAINT "DealRegistration_partnerContactId_fkey" FOREIGN KEY ("partnerContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_sourceInvoiceId_fkey" FOREIGN KEY ("sourceInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_sourceDealId_fkey" FOREIGN KEY ("sourceDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_renewalDealId_fkey" FOREIGN KEY ("renewalDealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_renewedFromId_fkey" FOREIGN KEY ("renewedFromId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_preparedById_fkey" FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteLine" ADD CONSTRAINT "QuoteLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerPoId_fkey" FOREIGN KEY ("customerPoId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_approvalRequestedById_fkey" FOREIGN KEY ("approvalRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_approvalDecidedById_fkey" FOREIGN KEY ("approvalDecidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approvalRequestedById_fkey" FOREIGN KEY ("approvalRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approvalDecidedById_fkey" FOREIGN KEY ("approvalDecidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_undoneById_fkey" FOREIGN KEY ("undoneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRule" ADD CONSTRAINT "NotificationRule_teamsWebhookId_fkey" FOREIGN KEY ("teamsWebhookId") REFERENCES "TeamsWebhook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Target" ADD CONSTRAINT "Target_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

