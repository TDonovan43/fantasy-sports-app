-- AlterTable
ALTER TABLE "Player" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "Slate" ADD COLUMN     "salaryCap" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PlayerProjection" ADD COLUMN     "gameKey" TEXT,
ADD COLUMN     "opponent" TEXT;

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "slateId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "kickoff" TIMESTAMP(3),
    "pointSpread" DOUBLE PRECISION,
    "overUnder" DOUBLE PRECISION,
    "channel" TEXT,
    "status" TEXT,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Game_slateId_idx" ON "Game"("slateId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_externalId_key" ON "Player"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Slate_source_season_week_gameType_key" ON "Slate"("source", "season", "week", "gameType");

-- CreateIndex
CREATE INDEX "PlayerSalary_slateId_idx" ON "PlayerSalary"("slateId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerSalary_playerId_slateId_source_key" ON "PlayerSalary"("playerId", "slateId", "source");

-- CreateIndex
CREATE INDEX "PlayerProjection_slateId_idx" ON "PlayerProjection"("slateId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerProjection_playerId_slateId_source_key" ON "PlayerProjection"("playerId", "slateId", "source");

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_slateId_fkey" FOREIGN KEY ("slateId") REFERENCES "Slate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

