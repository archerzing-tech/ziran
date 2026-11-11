// 让 tsc 直接检查时认识 vite 打包的副作用导入（css 等）；运行时由 vite 处理
declare module '*.css'
