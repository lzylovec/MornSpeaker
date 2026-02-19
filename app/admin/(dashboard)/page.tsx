import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@supabase/supabase-js";
import { Users, MessageSquare, Activity } from "lucide-react";
import { getPrisma } from "@/lib/prisma";
import { TrtcToggle } from "./trtc-toggle";
import { getTrtcEnabled } from "@/app/admin/actions";

export const dynamic = 'force-dynamic';

export default async function AdminDashboard() {
  const target = String(process.env.DEPLOY_TARGET ?? process.env.NEXT_PUBLIC_DEPLOY_TARGET ?? "")
    .trim()
    .toLowerCase()
  const isTencent = target === "tencent"
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  
  let userCount = 0;
  let roomCount = 0;
  let messageCount = 0;
  let trtcEnabled = false;

  // 获取 TRTC 设置
  const trtcRes = await getTrtcEnabled();
  trtcEnabled = trtcRes.success ? trtcRes.enabled : false;

  if (isTencent) {
    const prisma = await getPrisma()
    const [uCount, rCount, mCount] = await Promise.all([
      prisma.user.count(),
      prisma.room.count(),
      prisma.roomMessage.count(),
    ])
    userCount = uCount
    roomCount = rCount
    messageCount = mCount
  } else if (supabaseUrl && supabaseKey) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseKey;
    const supabase = createClient(supabaseUrl, key);

    // 获取统计数据
    const { count: uCount } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
    const { count: rCount } = await supabase.from('rooms').select('*', { count: 'exact', head: true });
    const { count: mCount } = await supabase.from('room_messages').select('*', { count: 'exact', head: true });
    
    userCount = uCount || 0;
    roomCount = rCount || 0;
    messageCount = mCount || 0;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold tracking-tight">概览</h2>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">总用户数</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{userCount}</div>
            <p className="text-xs text-muted-foreground">
              注册用户总数
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">房间总数</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{roomCount}</div>
            <p className="text-xs text-muted-foreground">
              创建的翻译房间
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">消息总数</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{messageCount}</div>
            <p className="text-xs text-muted-foreground">
              已翻译的消息总数
            </p>
          </CardContent>
        </Card>
      </div>
      
      {/* TRTC 开关 */}
      <TrtcToggle initialEnabled={trtcEnabled} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>最近活动</CardTitle>
          </CardHeader>
          <CardContent>
             <div className="flex items-center justify-center h-[200px] text-muted-foreground">
                暂无活动数据图表
             </div>
          </CardContent>
        </Card>
        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>系统状态</CardTitle>
          </CardHeader>
          <CardContent>
             <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">数据库连接</span>
                    <span className="text-sm text-green-500">正常</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">翻译服务</span>
                    <span className="text-sm text-green-500">运行中</span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">字幕翻译服务</span>
                    <span className="text-sm text-green-500">{trtcEnabled ? "TRTC字幕增强" : "标准字幕引擎"}</span>
                </div>
             </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
