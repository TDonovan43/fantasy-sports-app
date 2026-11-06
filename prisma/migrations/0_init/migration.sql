-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "team" TEXT,
    "position" TEXT NOT NULL,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Slate" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "slateDate" TIMESTAMP(3) NOT NULL,
    "gameType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Slate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSalary" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "slateId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "salary" INTEGER NOT NULL,
    "rosterPosition" TEXT NOT NULL,
    "isCaptain" BOOLEAN DEFAULT false,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerSalary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerProjection" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "slateId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "projectedFantasyPoints" DOUBLE PRECISION NOT NULL,
    "floor" DOUBLE PRECISION,
    "ceiling" DOUBLE PRECISION,
    "projectedRushYds" DOUBLE PRECISION,
    "projectedRushTds" DOUBLE PRECISION,
    "projectedRecYds" DOUBLE PRECISION,
    "projectedRecTds" DOUBLE PRECISION,
    "projectedPassYds" DOUBLE PRECISION,
    "projectedPassTds" DOUBLE PRECISION,
    "projectedTargets" DOUBLE PRECISION,
    "projectedSnaps" DOUBLE PRECISION,
    "projectedOwnership" DOUBLE PRECISION,
    "modelVersion" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerGameLog" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "opponentTeamId" TEXT,
    "passYds" DOUBLE PRECISION,
    "passTds" DOUBLE PRECISION,
    "rushYds" DOUBLE PRECISION,
    "rushTds" DOUBLE PRECISION,
    "recYds" DOUBLE PRECISION,
    "recTds" DOUBLE PRECISION,
    "targets" DOUBLE PRECISION,
    "receptions" DOUBLE PRECISION,
    "carries" DOUBLE PRECISION,
    "snaps" DOUBLE PRECISION,
    "fantasyPoints" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerGameLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InjuryStatus" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "InjuryStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSnapshot" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "snapShare" DOUBLE PRECISION,
    "targetShare" DOUBLE PRECISION,
    "redZoneTouches" DOUBLE PRECISION,
    "goalLineTouches" DOUBLE PRECISION,
    "carryShare" DOUBLE PRECISION,
    "routeRate" DOUBLE PRECISION,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageSnapshot_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PlayerSalary" ADD CONSTRAINT "PlayerSalary_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerSalary" ADD CONSTRAINT "PlayerSalary_slateId_fkey" FOREIGN KEY ("slateId") REFERENCES "Slate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerProjection" ADD CONSTRAINT "PlayerProjection_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerProjection" ADD CONSTRAINT "PlayerProjection_slateId_fkey" FOREIGN KEY ("slateId") REFERENCES "Slate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerGameLog" ADD CONSTRAINT "PlayerGameLog_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InjuryStatus" ADD CONSTRAINT "InjuryStatus_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSnapshot" ADD CONSTRAINT "UsageSnapshot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

