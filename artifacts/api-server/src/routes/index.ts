import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pokerRouter from "./poker";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pokerRouter);

export default router;
