-- CreateTable
CREATE TABLE "ComponentCheck" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComponentCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComponentCheck_component_at_idx" ON "ComponentCheck"("component", "at");

-- CreateIndex
CREATE INDEX "ComponentCheck_at_idx" ON "ComponentCheck"("at");
