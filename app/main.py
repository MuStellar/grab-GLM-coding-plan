from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from app.api.router import router as v1_router
from app.utils.errors import BadRequestError, ServiceError

def create_app() -> FastAPI:
    app = FastAPI(title="文字点选验证码识别服务", version="1.0.0")

    # 自己处理 CORS + PNA。不用 Starlette 的 CORSMiddleware，因为它会主动拒绝
    # 带 Access-Control-Request-Private-Network 的预检（返回 "Disallowed CORS private-network"），
    # 导致 https 页面（油猴脚本）对 localhost 的 POST 被 Chrome 拦截（GET 无预检故能通）。
    @app.middleware("http")
    async def cors_and_pna(request: Request, call_next):
        if request.method == "OPTIONS":
            # 直接放行所有预检（含 PNA），返回浏览器需要的头
            return Response(status_code=200, headers={
                "Access-Control-Allow-Origin": request.headers.get("origin", "*"),
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers", "*"),
                "Access-Control-Allow-Private-Network": "true",
                "Access-Control-Max-Age": "86400",
            })
        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = request.headers.get("origin", "*")
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    @app.exception_handler(BadRequestError)
    async def bad_request_handler(request: Request, exc: BadRequestError):
        return JSONResponse(status_code=400, content={"code": 400, "msg": exc.detail, "data": None})

    @app.exception_handler(ServiceError)
    async def service_error_handler(request: Request, exc: ServiceError):
        return JSONResponse(status_code=500, content={"code": 500, "msg": exc.detail, "data": None})

    @app.get("/")
    def root():
        return {"code": 200, "msg": "成功", "data": "ok"}

    app.include_router(v1_router, prefix="/api/v1")
    return app

app = create_app()  # 供 uvicorn 直接导入