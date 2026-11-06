-- CreateTable
CREATE TABLE "DkSalary" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "dkId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "rosterPosition" TEXT NOT NULL,
    "salary" INTEGER NOT NULL,
    "team" TEXT NOT NULL,
    "opponent" TEXT,
    "kickoff" TEXT,
    "gameInfo" TEXT,
    "avgPoints" DOUBLE PRECISION NOT NULL,
    "status" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DkSalary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DkSalary_season_week_idx" ON "DkSalary"("season", "week");

