-- CreateTable
CREATE TABLE "ResourceSample" (
    "id" TEXT NOT NULL,
    "cpuPct" DOUBLE PRECISION NOT NULL,
    "memPct" DOUBLE PRECISION NOT NULL,
    "diskPct" DOUBLE PRECISION NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResourceSample_at_idx" ON "ResourceSample"("at");
