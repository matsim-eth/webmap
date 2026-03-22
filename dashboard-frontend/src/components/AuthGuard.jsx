import { useQuery } from "@tanstack/react-query";
import { checkAuth, redirectToLogin } from "../utils/auth";

export default function AuthGuard({ children }) {
  const { data: ready } = useQuery({
    queryKey: ['authCheck'],
    queryFn: async () => {
      const ok = await checkAuth();
      if (!ok) {
        redirectToLogin();
        return false;
      }
      return true;
    },
    staleTime: Infinity,
  });

  if (!ready) return null;
  return children;
}
