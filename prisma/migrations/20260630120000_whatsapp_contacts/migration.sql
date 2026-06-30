-- CreateTable
CREATE TABLE "whatsapp_contacts" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "windowExpiresAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_contacts_phone_key" ON "whatsapp_contacts"("phone");

-- CreateIndex
CREATE INDEX "whatsapp_contacts_windowExpiresAt_idx" ON "whatsapp_contacts"("windowExpiresAt");
